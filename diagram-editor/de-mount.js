(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // The parts are required when a call needs them, so loading this file loads no other.
    module.exports = factory(() => ({
      operations: require('./de-operations.js'),
      geometry: require('./de-geometry.js'),
      scene: require('./de-scene.js'),
      selection: require('./de-selection.js'),
      viewport: require('./de-viewport.js'),
      commands: require('./de-commands.js'),
      gesturesRoutes: require('./de-gestures-routes.js'),
      gesturesMove: require('./de-gestures-move.js'),
      gesturesConnect: require('./de-gestures-connect.js'),
      gesturesPalette: require('./de-gestures-palette.js'),
      gesturesSequence: require('./de-gestures-sequence.js'),
      gesturesMarquee: require('./de-gestures-marquee.js'),
      menus: require('./de-menus.js'),
      inline: require('./de-inline.js'),
      placing: require('./de-placing.js'),
      surfaceClassic: require('./de-surface-classic.js'),
      textSchemas: require('./text/te-schemas.js'),
      textRead: require('./text/te-read.js'),
      textSequence: require('./text/te-sequence.js'),
      text: require('./text/te-adapter.js'),
    }));
  } else if (!root.ArchUMLDiagramEditor) {
    // A second load of the module replaces nothing (spec §2.2): sessions mounted before it keep their editor.
    root.ArchUMLDiagramEditor = factory(() => root.ArchUMLDiagramEditorParts || {});
  }
})(typeof self !== 'undefined' ? self : this, function (partsNow) {
  'use strict';

  // The diagram editor's public face, `ArchUMLDiagramEditor` (UML-view editing spec §2.2, §2.4; plan Tasks 21 and 24):
  // the text adapter and the session, which mount() makes. It reads the parts on ArchUMLDiagramEditorParts when it is
  // called, never when it loads, so a group loaded later serves it, and a page that loads only the `core` group (the C4
  // editor) gets a named error, not a broken adapter.

  /** The error of a call that needs a group of diagram-editor/manifest.json the page has not loaded. */
  function partMissing(member, group) {
    const error = new Error(`ArchUMLDiagramEditor.${member} needs the "${group}" group of js/ArchUML/diagram-editor/manifest.json, which this page has not loaded.`);
    error.name = 'DiagramEditorPartMissing';
    return error;
  }

  /** The text adapter (spec §3.6) over `options`: `{ read(), write(text, info), type(), bundle }`. */
  function createTextAdapter(options) {
    const text = partsNow().text;
    if (!text) throw partMissing('createTextAdapter', 'text');
    return text.createTextAdapter(options);
  }

  /**
   * The session's view of the host's `env` (spec §2.4): the same document, clock, and bundle, and a `schedule` that
   * keeps every timer the session set until it runs or is cancelled, so `cancelAll()` (the session's destroy) can
   * cancel those still pending. `env.schedule(fn, ms)` returns the cancel function of its timer.
   */
  function sessionTimers(env) {
    var pending = [];
    function forget(timer) {
      var at = pending.indexOf(timer);
      if (at !== -1) pending.splice(at, 1);
    }
    var sessionEnv = Object.assign({}, env, {
      schedule: function (fn, ms) {
        var timer = {};
        timer.cancel = env.schedule(function () {
          forget(timer);
          fn();
        }, ms);
        pending.push(timer);
        return function cancel() {
          forget(timer);
          timer.cancel();
        };
      }
    });
    return {
      env: sessionEnv,
      cancelAll: function () {
        pending.splice(0).forEach(function (timer) { timer.cancel(); });
      }
    };
  }

  // ---------- the module half: one diagram editor session (spec §2.4, §3.3; plan Task 18) ----------
  //
  // The canvas's state and code: the selection, the active tool, drags and click tracking, menus and
  // in-place editors, the view, the scene caches, and the canvas constants. A session is made from its
  // mount options alone: `root` bounds the editor, `canvas` holds the drawing, `adapter` is the edit
  // adapter, `host` the host's services, `env` the page's document, clock, timer, and bundle, and
  // `elements` the page elements the classic surface works with. It reads the document only through
  // the adapter and the page only through `env`; the host reaches its state only through the members
  // it returns. A drawing's selection to restore travels in `sync` (`restore`).
  //
  // Since plan Task 24 the session is this file's. Its functions came from the inline script of _includes/uml-editor.html
  // without a changed statement (spec §3.6), except where noted: it reads the parts and the grammar it calls by name when
  // it is mounted (they were aliases at the script's top level); relationFields came along from there; the hit layer, the
  // palette, the empty-canvas actions, and the pointer driver went to the classic surface (de-surface-classic.js), which
  // the session makes first, and whose listeners for the session's whole life it adds once the pointer driver exists;
  // the page elements only the surface uses are no longer read here; the palette drag joins the kit for the surface;
  // and scene() names the surface's activation bars.
  function createDiagramEditorSession(options) {
    var parts = partsNow();
    // A host surface (spec §7.3; plan Task 38) brings its own targets, keys, and view, and its adapter its own document:
    // its page may load the `core` group alone, so the text group's grammar is then absent and nothing here calls it.
    var hostSurface = options.surface !== 'classic';
    if (!hostSurface && !parts.textRead) throw partMissing('mount', 'text');
    var textRead = parts.textRead || {};
    var textSequence = parts.textSequence || {};
    var textSchemas = parts.textSchemas || {};
    // What the session calls by name of the module's parts and of the text group's ArchUML grammar (the classic
    // session edits ArchUML text): read from ArchUMLDiagramEditorParts when the session is mounted.
    var SEQUENCE_FRAGMENT_KINDS = textSequence.SEQUENCE_FRAGMENT_KINDS;
    var activityLabelForNode = textRead.activityLabelForNode;
    var activityLayoutIdForNode = textRead.activityLayoutIdForNode;
    var clampSlot = textSequence.clampSlot;
    var clonePointsOf = parts.scene.clonePointsOf;
    var createClassicPointerDriver = parts.surfaceClassic.createClassicPointerDriver;
    var createCommands = parts.commands.createCommands;
    var createSelection = parts.selection.createSelection;
    var cssAttrEscape = parts.scene.cssAttrEscape;
    var diagramSupportsAnchoredNotes = textSchemas.diagramSupportsAnchoredNotes;
    var diagramSupportsCreation = textSchemas.diagramSupportsCreation;
    var elementSchemasFor = textSchemas.elementSchemasFor;
    var escapeQuoted = textRead.escapeQuoted;
    var componentDeclaration = textRead.componentDeclaration;
    var findElementSchema = textSchemas.findElementSchema;
    var findInsertPointForDeclaration = textRead.findInsertPointForDeclaration;
    var findRenderedBox = parts.scene.findRenderedBox;
    var identifierFromInlineLabel = textRead.identifierFromInlineLabel;
    var joiningPreviousStep = parts.commands.joiningPreviousStep;
    var layoutRouteStorageKey = parts.scene.layoutRouteStorageKey;
    var parseMemberLine = textRead.parseMemberLine;
    var readScene = parts.scene.readScene;
    var relationEndpointsAsDrawn = textRead.relationEndpointsAsDrawn;
    var relationLineOptions = textRead.relationLineOptions;
    var relationOfLine = textRead.relationOfLine;
    var relationSchemasFor = textSchemas.relationSchemasFor;
    var sequenceMessageBlockForLine = textSequence.sequenceMessageBlockForLine;
    var sequenceMessageLineIndices = textSequence.sequenceMessageLineIndices;
    var textGrammar = textRead.textGrammar;

    var host = options.host;
    var adapter = options.adapter;
    var timers = sessionTimers(options.env);
    var env = timers.env;
    var output = options.canvas;
    var wrap = options.root;
    // The page elements of the classic surface; a host surface has none of them.
    var pageElements = options.elements || {};
    var previewPane = pageElements.previewPane;
    var snapToggle = pageElements.snapToggle;
    var resetOneBtn = pageElements.resetOneBtn;
    // Removes the listeners the session adds for its whole life (spec §2.4, destroy).
    var sessionListeners = new AbortController();

    // The relation as the editor holds it, as the fields its line is built from: its kind, its ends, and
    // what relationLineOptions re-emits.
    function relationFields(info) {
      return Object.assign({ kind: info.kind, source: info.source, target: info.target }, relationLineOptions(info));
    }

    // The selection as the host reads it: the primary item, its kind, every selected item, and how many.
    function selection() {
      var primary = selectedLayout.primary();
      var ids = {};
      selectedLayout.all().forEach(function (ref) { ids[ref.id] = ref.kind; });
      return { id: primary ? primary.id : null, kind: primary ? primary.kind : null, ids: ids, size: selectionSize() };
    }

    // The selection set (de-selection.js): every selected item with its kind ('node', 'route', 'fragment',
    // 'activation'), and the primary one, the most recent click, which the props panel follows.
    var selectedLayout = createSelection();
    function selectionSize() { return selectedLayout.all().length; }
    // The primary item's id, or null.
    function selectedLayoutPrimaryId() {
      var primary = selectedLayout.primary();
      return primary ? primary.id : null;
    }
    // Whether `id` is the primary item, selected as `kind`.
    function isPrimarySelection(id, kind) {
      var primary = selectedLayout.primary();
      return !!primary && primary.id === id && primary.kind === kind;
    }
    // Whether `id` is selected as `kind`.
    function isSelectedAs(id, kind) {
      return selectedLayout.has({ id: id, kind: kind });
    }
    // The selection the next editable drawing brings back: a sync's `restore` (a write's verdict, an
    // undo's captured selection) or a command's "selected from the next drawing on". A drawing that is
    // not editable leaves it for the next one. It belongs to the selection, so only the session holds it.
    var selectionAwaitingDrawing = null;
    // Lets `ref` (or nothing, for null) wait for the next editable drawing; returns what waited before,
    // so a refused change can put it back.
    function selectWhenDrawn(ref) {
      var before = selectionAwaitingDrawing;
      selectionAwaitingDrawing = ref;
      return before;
    }
    // The scene (de-scene.js) of the drawing `svg`, read with the document as the adapter reads it now.
    function sceneOf(svg) {
      return readScene(svg, adapter.contents(), env.bundle);
    }
    function findEditableElements(svg) {
      if (!svg) return [];
      return sceneOf(svg).items();
    }
    /**
     * @param {string|null} id    The element/route to select. null clears.
     * @param {string} kind       'node' | 'route'
     * @param {object} [opts]
     * @param {boolean} [opts.extend]  Toggle id in the selection instead of
     *                                 replacing — used by Cmd/Ctrl/Shift+click.
     */
    // Fragments and activation bars have hitboxes like elements do, but they
    // are selected, edited and deleted as what they are. Their ids say so.
    function selectionKindForId(id, kind) {
      if (kind && kind !== 'node') return kind;
      if (/^frag:/.test(String(id))) return 'fragment';
      if (/^actbar:/.test(String(id))) return 'activation';
      return 'node';
    }

    function setSelectedLayoutId(id, kind, opts) {
      opts = opts || {};
      var k = selectionKindForId(id, kind);
      if (!id) {
        selectedLayout.clear();
      } else if (opts.extend) {
        // Removing the primary makes the most recently kept one the primary.
        selectedLayout.toggle({ id: id, kind: k });
      } else {
        selectedLayout.set({ id: id, kind: k });
      }
      if (resetOneBtn) resetOneBtn.disabled = selectionSize() !== 1;
      var layer = output.querySelector('.uml-pg-edit-layer');
      if (layer) {
        Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-edit-hitbox')).forEach(function (rect) {
          var rid = rect.getAttribute('data-layout-id');
          rect.classList.toggle('is-selected', isSelectedAs(rid, 'node') || isSelectedAs(rid, 'fragment'));
        });
        Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-edge-hitbox')).forEach(function (line) {
          var rid = line.getAttribute('data-layout-id');
          line.classList.toggle('is-selected', isSelectedAs(rid, 'route'));
        });
        Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-activation-hitbox, .uml-pg-activation-handle')).forEach(function (el) {
          var rid = el.getAttribute('data-layout-id');
          el.classList.toggle('is-selected', isSelectedAs(rid, 'activation'));
        });
      }
      if (host.onSelectionChange) host.onSelectionChange(selection());
      if (options.bendNumbers && kit.showBendNumbers) kit.showBendNumbers();
      // The classic surface's "⋯" button follows the selection (spec §3.11).
      if (kit.refreshActionButton) kit.refreshActionButton();
    }
    function findEditableRoutes(svg) {
      return sceneOf(svg).routes();
    }
    var renamingId = null; // id currently in rename mode
    function focusLayoutTarget(id) {
      if (!id) return;
      var newSvg = output.querySelector('svg');
      if (!newSvg) return;
      var target = newSvg.querySelector('.uml-pg-edit-a11y-target[data-layout-id="' + cssAttrEscape(id) + '"]');
      if (target && target.focus) target.focus();
    }

    // ---------- the module's parts (plan Task 23) ----------
    //
    // The session is made of the module's parts: the view (de-viewport.js), the commands (de-commands.js), the
    // gestures (de-gestures-*.js), the menus (de-menus.js), and the in-place editors (de-inline.js). Each part is
    // made from the kit: the session's own values and functions it uses, and the commands of createCommands. Each
    // part's members join the kit, and once the pointer driver exists, link() hands each part what it uses of
    // the others. The session reaches the members it uses by name, below.
    var kit = {
      SEQUENCE_FRAGMENT_KINDS: SEQUENCE_FRAGMENT_KINDS,
      activityLabelForNode: activityLabelForNode,
      activityLayoutIdForNode: activityLayoutIdForNode,
      adapter: adapter,
      bendNumbers: !!options.bendNumbers,
      clampSlot: clampSlot,
      clonePointsOf: clonePointsOf,
      commands: createCommands({ adapter: adapter, host: host, selection: selectedLayout }),
      componentDeclaration: componentDeclaration,
      diagramSupportsAnchoredNotes: diagramSupportsAnchoredNotes,
      diagramSupportsCreation: diagramSupportsCreation,
      elementSchemasFor: elementSchemasFor,
      elements: pageElements,
      env: env,
      escapeQuoted: escapeQuoted,
      findEditableElements: findEditableElements,
      findEditableRoutes: findEditableRoutes,
      findElementSchema: findElementSchema,
      findInsertPointForDeclaration: findInsertPointForDeclaration,
      focusLayoutTarget: focusLayoutTarget,
      host: host,
      identifierFromInlineLabel: identifierFromInlineLabel,
      isPrimarySelection: isPrimarySelection,
      isSelectedAs: isSelectedAs,
      joiningPreviousStep: joiningPreviousStep,
      layoutRouteStorageKey: layoutRouteStorageKey,
      output: output,
      parseMemberLine: parseMemberLine,
      previewPane: previewPane,
      relationEndpointsAsDrawn: relationEndpointsAsDrawn,
      relationFields: relationFields,
      relationOfLine: relationOfLine,
      relationSchemasFor: relationSchemasFor,
      resetOneBtn: resetOneBtn,
      sceneOf: sceneOf,
      selectWhenDrawn: selectWhenDrawn,
      selectedLayout: selectedLayout,
      selectedLayoutPrimaryId: selectedLayoutPrimaryId,
      selection: selection,
      selectionSize: selectionSize,
      sequenceMessageBlockForLine: sequenceMessageBlockForLine,
      sequenceMessageLineIndices: sequenceMessageLineIndices,
      serializers: adapter.serializers,
      sessionListeners: sessionListeners,
      selectionKindForId: selectionKindForId,
      setSelectedLayoutId: setSelectedLayoutId,
      snapToggle: snapToggle,
      textGrammar: textGrammar,
      wrap: wrap
    };
    // The classic surface comes first: the parts made after it take members of its hit layer when they are made. A host
    // surface is the host's (spec §7.3): the module makes none, and the host's view replaces the module's.
    var classicSurface = hostSurface ? null : parts.surfaceClassic.createClassicSurface(kit);
    if (classicSurface) Object.assign(kit, classicSurface.members);
    var viewport = options.viewport === 'host' ? parts.viewport.createHostViewport(kit) : parts.viewport.createViewport(kit);
    var classicCommands = parts.commands.createClassicCommands(kit);
    var routeGestures = parts.gesturesRoutes.createRouteGestures(kit);
    var moveGestures = parts.gesturesMove.createMoveGestures(kit);
    var connectGestures = parts.gesturesConnect.createConnectGestures(kit);
    var paletteGestures = parts.gesturesPalette.createPaletteGestures(kit);
    var sequenceGestures = parts.gesturesSequence.createSequenceGestures(kit);
    var marqueeGesture = parts.gesturesMarquee.createMarqueeGesture(kit);
    var menus = parts.menus.createMenus(kit);
    var inlineEditors = parts.inline.createInlineEditors(kit);
    var placing = parts.placing.createPlacing(kit);
    var moduleParts = [classicSurface, viewport, classicCommands, routeGestures, moveGestures, connectGestures, paletteGestures, sequenceGestures, marqueeGesture, menus, inlineEditors, placing].filter(Boolean);
    moduleParts.forEach(function (part) { Object.assign(kit, part.members); });
    var activationBars = kit.activationBars;
    var activationNudge = kit.activationNudge;
    var activityNodeInfoForId = kit.activityNodeInfoForId;
    var addDiagramStarter = kit.addDiagramStarter;
    var addElementWithoutCanvas = kit.addElementWithoutCanvas;
    var addEmptyElement = kit.addEmptyElement;
    var addFragmentElseBranch = kit.addFragmentElseBranch;
    var addSequenceParticipant = kit.addSequenceParticipant;
    var addSequenceStarterPair = kit.addSequenceStarterPair;
    var announce = kit.announce;
    var applyEditorCanvasBounds = kit.applyEditorCanvasBounds;
    var applyViewTransform = kit.applyViewTransform;
    var buildCanvasContextMenu = kit.buildCanvasContextMenu;
    var buildElementContextMenu = kit.buildElementContextMenu;
    var buildRouteContextMenu = kit.buildRouteContextMenu;
    var buildSequenceDetailContextMenu = kit.buildSequenceDetailContextMenu;
    var cancelActivationBarDrag = kit.cancelActivationBarDrag;
    var cancelExtendDrag = kit.cancelExtendDrag;
    var cancelDrag = kit.cancelDrag;
    var cancelFragmentDrag = kit.cancelFragmentDrag;
    var cancelInlineRename = kit.cancelInlineRename;
    var cancelSequenceGesture = kit.cancelSequenceGesture;
    var cancelSequenceMessageDrag = kit.cancelSequenceMessageDrag;
    var changeFragmentBranchCondition = kit.changeFragmentBranchCondition;
    var changeFragmentCondition = kit.changeFragmentCondition;
    var changeFragmentKind = kit.changeFragmentKind;
    var cleanupChooserListeners = kit.cleanupChooserListeners;
    var clearEditLayer = kit.clearEditLayer;
    var clearSmartGuides = kit.clearSmartGuides;
    var closeContextMenu = kit.closeContextMenu;
    var closeRelationChooser = kit.closeRelationChooser;
    var collectPositions = kit.collectPositions;
    var commitWrap = kit.commitWrap;
    var createPaletteDragGesture = kit.createPaletteDragGesture;
    var currentInlineInput = kit.currentInlineInput;
    var deleteSelected = kit.deleteSelected;
    var documentType = kit.documentType;
    var duplicateSelected = kit.duplicateSelected;
    var editorCanvasPoint = kit.editorCanvasPoint;
    var expandBoxToMinCssTarget = kit.expandBoxToMinCssTarget;
    var findClassMemberTextAt = kit.findClassMemberTextAt;
    var fragmentForMessageLine = kit.fragmentForMessageLine;
    var handleHitboxClickForAnchoredNoteTool = kit.handleHitboxClickForAnchoredNoteTool;
    var handleHitboxClickForRelation = kit.handleHitboxClickForRelation;
    var handleHitboxClickForSequenceElementTool = kit.handleHitboxClickForSequenceElementTool;
    var installGenericEmptyEditor = kit.installGenericEmptyEditor;
    var installSessionListeners = kit.installSessionListeners;
    var installVisualEditor = kit.installVisualEditor;
    var invertRelationDirection = kit.invertRelationDirection;
    var isDragging = kit.isDragging;
    var moveFragmentBy = kit.moveFragmentBy;
    var moveSequenceMessageBy = kit.moveSequenceMessageBy;
    var moveSequenceMessageToBranch = kit.moveSequenceMessageToBranch;
    var nudgeElement = kit.nudgeElement;
    var placeElementAt = kit.placeElementAt;
    var pointInsideElement = kit.pointInsideElement;
    var pressTaken = kit.pressTaken;
    var rebuildPalette = kit.rebuildPalette;
    var relationLineMatchForRouteId = kit.relationLineMatchForRouteId;
    var renameActivityElement = kit.renameActivityElement;
    var renameElement = kit.renameElement;
    var replaceLineForElementId = kit.replaceLineForElementId;
    var replaceRelationLine = kit.replaceRelationLine;
    var replaceVirtualNoteText = kit.replaceVirtualNoteText;
    var resetView = kit.resetView;
    var revealPending = kit.revealPending;
    var rewireRelationEndpoint = kit.rewireRelationEndpoint;
    var routeIdForSourceLine = kit.routeIdForSourceLine;
    var routeUsesLockedEndpoints = kit.routeUsesLockedEndpoints;
    var selectAll = kit.selectAll;
    var selectedRelationToolSpec = kit.selectedRelationToolSpec;
    var selectedSequenceMessageToolSpec = kit.selectedSequenceMessageToolSpec;
    var setActiveTool = kit.setActiveTool;
    var setRevealPending = kit.setRevealPending;
    var setRouteOverlaySegment = kit.setRouteOverlaySegment;
    var showVerdict = kit.showVerdict;
    var startActivationBarGesture = kit.startActivationBarGesture;
    var startElementMove = kit.startElementMove;
    var startExtendHandleDrag = kit.startExtendHandleDrag;
    var startFragmentGesture = kit.startFragmentGesture;
    var startHitboxPress = kit.startHitboxPress;
    var startInlineFragmentConditionEdit = kit.startInlineFragmentConditionEdit;
    var startInlineFragmentEdit = kit.startInlineFragmentEdit;
    var startInlineMemberEdit = kit.startInlineMemberEdit;
    var startInlineRelationEdit = kit.startInlineRelationEdit;
    var startInlineRename = kit.startInlineRename;
    var startMarquee = kit.startMarquee;
    var startPlacementPress = kit.startPlacementPress;
    var startRouteEdit = kit.startRouteEdit;
    var startSequenceMessageGesture = kit.startSequenceMessageGesture;
    var stopEditing = kit.stopEditing;
    var toolState = kit.toolState;
    var unwrapFragment = kit.unwrapFragment;
    var updateZoomReadout = kit.updateZoomReadout;
    var virtualNoteText = kit.virtualNoteText;
    var zoomAt = kit.zoomAt;
    var zoomIn = kit.zoomIn;
    var zoomOut = kit.zoomOut;
    var zoomToFit = kit.zoomToFit;

    // The classic surface's drags, in the order a press asks them (spec §3.8): today's precedence where
    // the gestures of one press site test their conditions. On a drawn item a message tool's drag comes
    // first, then a press that selects or edits in place, then the move; on the canvas a message tool's
    // drag, then the Activate tool's, then the placement press; in the preview pane the placement press,
    // then the marquee.
    var paletteDrag = createPaletteDragGesture();
    var gestures = [
      { id: 'extend-handle', start: startExtendHandleDrag },
      { id: 'sequence-message', start: startSequenceMessageGesture },
      { id: 'hitbox-press', start: startHitboxPress },
      { id: 'fragment', start: startFragmentGesture },
      { id: 'activation-bar', start: startActivationBarGesture },
      { id: 'element-move', start: startElementMove },
      { id: 'route-edit', start: startRouteEdit },
      { id: 'placement-press', start: startPlacementPress },
      { id: 'marquee', start: startMarquee },
      paletteDrag
    ];
    // A host surface gets the factories that need no classic surface: the hit-box press is the classic surface's.
    if (hostSurface) {
      for (var factory = gestures.length - 1; factory >= 0; factory--) {
        if (typeof gestures[factory].start !== 'function') gestures.splice(factory, 1);
      }
    }
    // The classic surface's "⋯" button is absent while a drag runs (spec §3.11): it follows the driver's sessions.
    var pointer = createClassicPointerDriver(wrap.ownerDocument, gestures, function () {
      if (kit.refreshActionButton) kit.refreshActionButton();
    });
    kit.pointer = pointer;
    kit.paletteDrag = paletteDrag;
    moduleParts.forEach(function (part) { if (part.link) part.link(); });
    if (classicSurface) installSessionListeners();
    // ---------- what a host surface adds (spec §7.2–§7.4; plan Task 38) ----------
    // The module's hit layer over a host's drawing: one box per item and one line per segment of each line, as pointer
    // targets only (aria-hidden, no tab stop), each at least the least target size. The host's own targets (the C4
    // editor's listbox) carry the names, the roles, and the keys.
    function installHostLayer(svg) {
      removeHostLayer();
      if (!svg) return;
      var ns = 'http://www.w3.org/2000/svg';
      var layer = env.document.createElementNS(ns, 'g');
      layer.setAttribute('class', 'uml-pg-edit-layer is-host');
      layer.setAttribute('aria-hidden', 'true');
      svg.appendChild(layer);
      findEditableElements(svg).forEach(function (item) {
        var box = expandBoxToMinCssTarget(svg, item.box);
        var rect = env.document.createElementNS(ns, 'rect');
        rect.setAttribute('class', 'uml-pg-edit-hitbox');
        rect.setAttribute('data-layout-id', item.id);
        ['x', 'y', 'width', 'height'].forEach(function (name) { rect.setAttribute(name, box[name]); });
        layer.appendChild(rect);
      });
      findEditableRoutes(svg).forEach(function (route) {
        for (var i = 0; i + 1 < route.points.length; i++) {
          var segment = env.document.createElementNS(ns, 'line');
          segment.setAttribute('class', 'uml-pg-edge-hitbox');
          segment.setAttribute('data-layout-id', route.id);
          segment.setAttribute('data-route-id', route.id);
          segment.setAttribute('data-segment-index', String(i));
          setRouteOverlaySegment(segment, route.points[i], route.points[i + 1]);
          layer.appendChild(segment);
        }
      });
    }
    function removeHostLayer() {
      var svg = output.querySelector('svg');
      var layer = svg && svg.querySelector('.uml-pg-edit-layer');
      if (layer) layer.remove();
    }
    // The selection a sync names, once the host's drawing is there to show it.
    function restoreHostSelection() {
      var waiting = selectWhenDrawn(null);
      if (waiting && !waiting.ids) setSelectedLayoutId(waiting.id, waiting.kind);
      else setSelectedLayoutId(selectedLayoutPrimaryId(), selectedLayout.primary() ? selectedLayout.primary().kind : null);
    }
    // The candidates a host surface asked about (markTargets), in keyboard order, while their marks are shown.
    var hostTargets = null;
    function hostLayer() {
      var svg = output.querySelector('svg');
      return svg ? svg.querySelector('.uml-pg-edit-layer') : null;
    }
    function markHostTargets(request) {
      clearHostTargets();
      var advice = kit.commands.targetsFor(request);
      var svg = output.querySelector('svg');
      var layer = hostLayer();
      if (!advice || !layer) return null;
      var drawn = findEditableElements(svg);
      hostTargets = parts.scene.markTargets(layer, advice, function (id) {
        var item = drawn.find(function (candidate) { return candidate.id === id; });
        return item ? item.box : null;
      }, env.document);
      return hostTargets;
    }
    function clearHostTargets() {
      hostTargets = null;
      parts.scene.clearTargetMarks(hostLayer());
    }

    return {
      // The host calls it after every render: the hit layer is built again from the drawing, and the
      // selection `restore` names (if any) is brought back once a drawing is editable.
      // A move without a press that is still running ends: its drawing is gone (spec §3.11).
      sync: function (drawing, syncOptions) {
        placing.members.cancelPlacingForNewDrawing();
        var restore = syncOptions && syncOptions.restore ? syncOptions.restore : kit.commands.restoreForNextSync();
        if (restore) selectWhenDrawn(restore);
        if (hostSurface) {
          hostTargets = null;
          installHostLayer(drawing && drawing.svg ? drawing.svg : output.querySelector('svg'));
          restoreHostSelection();
        } else {
          installVisualEditor();
        }
        if (options.bendNumbers) kit.showBendNumbers();
      },
      // A move of a box or of one bend of a line without a press (spec §2.4, §3.11), which a surface or a host steers.
      startPlacing: placing.members.startPlacing,
      commands: {
        activationNudge: activationNudge,
        activityNodeInfoForId: activityNodeInfoForId,
        addBend: placing.members.addBend,
        addFragmentElseBranch: addFragmentElseBranch,
        addSequenceParticipant: addSequenceParticipant,
        bends: placing.members.bends,
        cancelActivationBarDrag: cancelActivationBarDrag,
        cancelExtendDrag: cancelExtendDrag,
        cancelDrag: cancelDrag,
        cancelFragmentDrag: cancelFragmentDrag,
        cancelInlineRename: cancelInlineRename,
        cancelSequenceGesture: cancelSequenceGesture,
        cancelSequenceMessageDrag: cancelSequenceMessageDrag,
        changeFragmentBranchCondition: changeFragmentBranchCondition,
        changeFragmentCondition: changeFragmentCondition,
        changeFragmentKind: changeFragmentKind,
        clearEditLayer: clearEditLayer,
        commitWrap: commitWrap,
        deleteSelected: deleteSelected,
        duplicateSelected: duplicateSelected,
        focusLayoutTarget: focusLayoutTarget,
        fragmentForMessageLine: fragmentForMessageLine,
        inlineRenameInput: currentInlineInput,
        installGenericEmptyEditor: installGenericEmptyEditor,
        invertRelationDirection: invertRelationDirection,
        isDragging: isDragging,
        moveFragmentBy: moveFragmentBy,
        moveSequenceMessageBy: moveSequenceMessageBy,
        moveSequenceMessageToBranch: moveSequenceMessageToBranch,
        rebuildPalette: rebuildPalette,
        relationLineMatchForRouteId: relationLineMatchForRouteId,
        removeBend: placing.members.removeBend,
        // Branch `branch` of the fragment `ref` taken away; only a host surface's adapter serves it (plan Task 38).
        removeBranch: kit.commands.removeBranch,
        renameActivityElement: renameActivityElement,
        renameElement: renameElement,
        // The element `ref` put into `parent`, or at the top level for null; a host surface's (spec §3.4).
        reparent: kit.commands.reparent,
        replaceLineForElementId: replaceLineForElementId,
        replaceRelationLine: replaceRelationLine,
        replaceVirtualNoteText: replaceVirtualNoteText,
        rewireRelationEndpoint: rewireRelationEndpoint,
        selectAll: selectAll,
        showVerdict: showVerdict,
        startInlineRename: startInlineRename,
        stopEditing: stopEditing,
        straighten: placing.members.straighten,
        unwrapFragment: unwrapFragment,
        virtualNoteText: virtualNoteText
      },
      // The drags as gesture factories, in the order the classic pointer driver asks them (spec §3.8).
      gestures: gestures,
      // Selects `ref` (null: nothing) now, or with `{ whenDrawn: true }` in the next editable drawing
      // (null then cancels the selection that waits for one).
      select: function (ref, selectOptions) {
        if (selectOptions && selectOptions.whenDrawn) selectWhenDrawn(ref);
        else setSelectedLayoutId(ref ? ref.id : null, ref ? ref.kind : null);
      },
      selection: selection,
      // Target marks for a host surface's gesture with an open end (spec §7.4): asks the adapter's `targets` about
      // `request` once and marks each candidate; returns the candidates in keyboard order (possible ones first), or
      // null without advice. clearTargets takes the marks away; a sync does too. targets() gives the candidates marked
      // now, by the host or by a running move.
      markTargets: markHostTargets,
      clearTargets: clearHostTargets,
      targets: function () { return hostTargets || kit.currentTargets(); },
      setTool: function (tool) { setActiveTool(tool ? tool.kind : null, tool ? tool.spec : undefined); },
      tool: function () { return toolState.activeTool; },
      // The host's own view replaces the module's under `viewport: 'host'`, so there is none to steer.
      viewport: options.viewport === 'host' ? null : {
        zoomIn: zoomIn,
        zoomOut: zoomOut,
        fit: zoomToFit,
        reset: resetView,
        updateReadout: updateZoomReadout,
        applyCanvasBounds: applyEditorCanvasBounds,
        // The next drawing brings its first target into view (after a switch of diagram type).
        revealOnNextSync: function () { setRevealPending(true); }
      },
      // What is drawn: the editable items and routes of a drawing, their boxes and positions, and the
      // activation bars of the last drawing.
      scene: function () {
        return {
          editables: findEditableElements,
          routes: findEditableRoutes,
          boxOf: findRenderedBox,
          positionsOf: collectPositions,
          activationBars: activationBars ? activationBars() : []
        };
      },
      destroy: function () {
        placing.members.cancelPlacing();
        pointer.destroy();
        timers.cancelAll();
        sessionListeners.abort();
        closeContextMenu();
        closeRelationChooser();
        cleanupChooserListeners();
        cancelInlineRename();
        if (classicSurface) {
          classicSurface.members.removeSurface();
        } else {
          removeHostLayer();
          options.detachSurface();
        }
      }
    };
  }

  /**
   * Mounts a session (spec §2.4) on `options`: `{ root, canvas, adapter, host, surface = 'classic', viewport = 'classic', idPrefix, env,
   * elements, bendNumbers = false }`. `elements` holds the page elements the classic surface works with: `palette`,
   * `paletteElements`, `paletteRelations`, `toolCancel`, and the classic host's further ones (`previewPane`, `status`,
   * `editToggle`, `snapToggle`, `resetOneBtn`, `propsContent`, `zoomReadout`, `zoomIn`, `zoomOut`). With `bendNumbers`
   * the bends of the one selected line show their numbers (spec §3.11). Returns the session: `sync`, `startPlacing`,
   * `commands` (with the bend commands `bends`, `addBend`, `removeBend`, `straighten`), `gestures`, `select`,
   * `selection`, `setTool`, `tool`, `viewport`, `scene`, and `destroy`.
   * The classic surface needs the `text` group of the manifest.
   *
   * A host that brings its own surface (spec §7.3; plan Task 38) passes `surface: { attach(session) → { detach() } }`
   * and `viewport: 'host'`, and needs only the `core` group. The module then makes no surface: it adds an aria-hidden
   * hit layer to each drawing it is synced with, applies no view transform, sizes nothing, and maps a pointer through
   * the drawing's screen CTM, so the host's own pan and zoom hold. `attach` is called once with the session, `detach`
   * by destroy. Such a session also has `markTargets(request)`, `clearTargets()`, and `targets()`, and its `viewport`
   * is null.
   */
  function mount(options) {
    const surface = options.surface === undefined ? 'classic' : options.surface;
    const viewport = options.viewport === undefined ? 'classic' : options.viewport;
    const hostSurface = surface !== 'classic';
    if (hostSurface && (typeof surface !== 'object' || surface === null || typeof surface.attach !== 'function')) {
      throw new TypeError('ArchUMLDiagramEditor.mount: surface is "classic" or a host surface { attach(session) }.');
    }
    if (hostSurface !== (viewport === 'host')) {
      throw new TypeError('ArchUMLDiagramEditor.mount: a host surface goes with viewport "host", the classic surface with the module\'s own view.');
    }
    if (!hostSurface) return createDiagramEditorSession(Object.assign({}, options, { surface, viewport }));
    // The host surface sees the whole session once; the session's destroy lets it go.
    let attachment = null;
    const session = createDiagramEditorSession(Object.assign({}, options, {
      surface, viewport, detachSurface: () => { if (attachment) attachment.detach(); },
    }));
    attachment = surface.attach(session);
    return session;
  }

  return { createTextAdapter, mount };
});
