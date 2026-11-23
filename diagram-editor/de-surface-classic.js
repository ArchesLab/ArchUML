(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./de-geometry.js'), require('./de-scene.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.surfaceClassic) parts.surfaceClassic = factory(parts.geometry, parts.scene);
  }
})(typeof self !== 'undefined' ? self : this, function (geometry, scene) {
  'use strict';

  // The classic surface of a session (UML-view editing spec §2.2, §3.2, §3.3, §3.8; plan Task 24): the UML editor's
  // accessible targets over the drawing (the hit layer, its handles, and its keys), the palette and its icons, the
  // actions of an empty canvas, the tool status the drawing gives, and the pointer driver that runs the drags. It owns
  // the click tracking of the double-click window and the hit layer's caches (the activation bars of the last drawing).
  // A host surface (spec §7.3) replaces it and keeps the gestures.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var cssAttrEscape = scene.cssAttrEscape;
  var editableRouteSegmentIndices = geometry.editableRouteSegmentIndices;
  var findRenderedFragments = scene.findRenderedFragments;

  // ---------- the classic pointer driver (spec §3.8; plan Task 19) ----------
  //
  // Every drag of the classic surface is a gesture factory `{ id, start(event, press) }`. A press site (a
  // hit target of the drawing, the canvas, the preview pane, or a palette button) hands its pointer press
  // to `press(event, press)`, which asks the factories in order and runs the first session one returns:
  // `{ move(event), end(event), cancel(event) }` (`press` describes the site; `start` returns null to pass).
  // While a session runs, listeners on `doc` (the root's document) hand it the pointer's moves and its
  // release, under the session's own AbortController, and they go when it ends. A session may keep R0's
  // ways of listening:
  // - `capture`: its listeners take the capture phase;
  // - `mouse`: mouse moves and releases reach it too;
  // - `cancelOnPointerCancel`: a pointer cancel cancels it; any other session runs on through one until a
  //   release, as at R0;
  // - `slot`: the R0 drag state it stands for; a new session of the same slot replaces it unannounced, as
  //   a new drag overwrote that state.
  // `running(id)` is the session of factory `id` that has started and not yet finished ending (so a reader
  // during its drop still finds it), or null; `cancel(id)` cancels it and tells whether one ran.
  // `hold(id, session)` runs a session with no press (a move without a drag, spec §3.11): the pointer's moves and its
  // next release reach it as a drag's do. `onChange`, if given, is called whenever a session starts or has ended.
  function createClassicPointerDriver(doc, gestures, onChange) {
    function changed() { if (onChange) onChange(); }
    var runs = [];
    function latestRun(id, includeEnding) {
      for (var i = runs.length - 1; i >= 0; i--) {
        if (runs[i].id === id && (includeEnding || !runs[i].ending)) return runs[i];
      }
      return null;
    }
    function forget(run) {
      run.listening.abort();
      var at = runs.indexOf(run);
      if (at !== -1) runs.splice(at, 1);
      changed();
    }
    function finish(run, how, event) {
      run.listening.abort();
      run.ending = true;
      run.session[how](event);
      forget(run);
    }
    function listen(run) {
      var session = run.session;
      var options = { capture: !!session.capture, signal: run.listening.signal };
      function onMove(event) { session.move(event); }
      function onRelease(event) { finish(run, 'end', event); }
      doc.addEventListener('pointermove', onMove, options);
      doc.addEventListener('pointerup', onRelease, options);
      if (session.mouse) {
        doc.addEventListener('mousemove', onMove, options);
        doc.addEventListener('mouseup', onRelease, options);
      }
      if (session.cancelOnPointerCancel) {
        doc.addEventListener('pointercancel', function (event) { finish(run, 'cancel', event); }, options);
      }
    }
    function run(gesture, session) {
      if (session.slot) {
        runs.filter(function (other) { return other.session.slot === session.slot && !other.ending; }).forEach(forget);
      }
      var started = { id: gesture.id, session: session, listening: new AbortController(), ending: false };
      runs.push(started);
      listen(started);
      changed();
    }
    return {
      press: function (event, press) {
        for (var i = 0; i < gestures.length; i++) {
          var session = gestures[i].start(event, press);
          if (session) {
            run(gestures[i], session);
            return session;
          }
        }
        return null;
      },
      hold: function (id, session) {
        run({ id: id }, session);
        return session;
      },
      running: function (id) {
        var found = latestRun(id, true);
        return found ? found.session : null;
      },
      cancel: function (id) {
        var found = latestRun(id, false);
        if (!found) return false;
        finish(found, 'cancel');
        return true;
      },
      destroy: function () {
        runs.filter(function (found) { return !found.ending; }).forEach(function (found) { finish(found, 'cancel'); });
      }
    };
  }

  /**
   * The classic surface.
   *
   * The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
   * (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession, de-mount.js): it
   * takes the values and the session's functions it uses when it is made, and what it uses of the other parts and the
   * pointer driver when the session calls its link(). Its members join the kit; the session makes this part first, so
   * the parts made after it find the members they take when they are made (refreshActiveButtonStates, activationBars).
   * Changed statements: the activation bars read the document through `kit.commands` (a surface holds no adapter, spec
   * §2.1); the drawing's awaited selection is taken with selectWhenDrawn(null), which returns it; the page elements are
   * `kit.elements`; the listeners for the session's whole life are installSessionListeners, which the session calls once
   * the pointer driver exists.
   */
  function createClassicSurface(kit) {
    // What the session made this part with.
    var commands = kit.commands;
    var diagramSupportsCreation = kit.diagramSupportsCreation;
    var elementSchemasFor = kit.elementSchemasFor;
    var env = kit.env;
    var findEditableElements = kit.findEditableElements;
    var findEditableRoutes = kit.findEditableRoutes;
    var host = kit.host;
    var isPrimarySelection = kit.isPrimarySelection;
    var isSelectedAs = kit.isSelectedAs;
    var output = kit.output;
    var relationSchemasFor = kit.relationSchemasFor;
    var selectWhenDrawn = kit.selectWhenDrawn;
    var selectedLayoutPrimaryId = kit.selectedLayoutPrimaryId;
    var selection = kit.selection;
    var sessionListeners = kit.sessionListeners;
    var setSelectedLayoutId = kit.setSelectedLayoutId;
    var focusLayoutTarget = kit.focusLayoutTarget;
    var selectedLayout = kit.selectedLayout;
    var selectionSize = kit.selectionSize;
    // The page elements the classic surface works with.
    var editToggle = kit.elements.editToggle;
    var palette = kit.elements.palette;
    var paletteEls = kit.elements.paletteElements;
    var paletteRels = kit.elements.paletteRelations;
    var previewPane = kit.elements.previewPane;
    var propsContent = kit.elements.propsContent;
    var status = kit.elements.status;
    var toolCancel = kit.elements.toolCancel;
    // What the other parts and the pointer driver give this part, bound by link() once all of them exist.
    var activationNudge, addDiagramStarter, addElementWithoutCanvas, addEmptyElement, addSequenceParticipant,
      addSequenceStarterPair, announce, applyViewTransform, buildCanvasContextMenu, buildElementContextMenu,
      buildRouteContextMenu, buildSequenceDetailContextMenu, clearSmartGuides, deleteSelected, documentType,
      editorCanvasPoint, expandBoxToMinCssTarget, findClassMemberTextAt, handleHitboxClickForAnchoredNoteTool,
      handleHitboxClickForRelation, handleHitboxClickForSequenceElementTool, nudgeElement, paletteDrag,
      placeElementAt, pointInsideElement, pointer, pressTaken, revealPending, routeIdForSourceLine,
      routeUsesLockedEndpoints, selectedRelationToolSpec, selectedSequenceMessageToolSpec, setActiveTool,
      setRevealPending, setRouteOverlaySegment, startInlineFragmentConditionEdit, startInlineFragmentEdit,
      startInlineMemberEdit, startInlineRelationEdit, startInlineRename, toolState, zoomByWheel;
    // What the moves without a drag use of the other parts (plan Task 25c).
    var addBend, closeContextMenu, parseSvgViewBox, removeBend, showBendNumbers, startPlacing, straighten;

    // Manual double-click tracking — survives the per-render closures of
    // hitbox handlers because installVisualEditor() rebuilds the rect DOM
    // on every state change, throwing away any per-rect lastClickAt vars.
    var lastHitboxClick = { time: 0, itemId: null, x: 0, y: 0 };
    var lastRouteClick = { time: 0, routeId: null, x: 0, y: 0 };
    function clearEditLayer() {
      var svg = output.querySelector('svg');
      if (!svg) return;
      var layer = svg.querySelector('.uml-pg-edit-layer');
      if (layer) layer.remove();
      svg.classList.remove('uml-pg-editing');
      restoreStaticSvgSemantics(svg);
    }
    function installInteractiveSvgSemantics(svg) {
      if (!svg) return;
      if (!svg.hasAttribute('data-uml-pg-static-role')) {
        svg.setAttribute('data-uml-pg-static-role', svg.getAttribute('role') || '');
        svg.setAttribute('data-uml-pg-static-label', svg.getAttribute('aria-label') || '');
      }
      var label = svg.getAttribute('data-uml-pg-static-label') || svg.getAttribute('aria-label') || 'UML diagram';
      svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', label + ' interactive editor canvas');
    }
    function restoreStaticSvgSemantics(svg) {
      if (!svg || !svg.hasAttribute('data-uml-pg-static-role')) return;
      var role = svg.getAttribute('data-uml-pg-static-role');
      var label = svg.getAttribute('data-uml-pg-static-label');
      if (role) svg.setAttribute('role', role);
      else svg.removeAttribute('role');
      if (label) svg.setAttribute('aria-label', label);
      else svg.removeAttribute('aria-label');
      svg.removeAttribute('data-uml-pg-static-role');
      svg.removeAttribute('data-uml-pg-static-label');
    }
    function revealEditorTarget(target) {
      if (!target || !output.contains(target) || heldMove()) return;
      // SVG focus does not consistently scroll overflow containers in browsers.
      // Keep the readable scale, moving only the editor's scrollable viewports.
      [output, previewPane].forEach(function (container) {
        if (!container || !container.contains(target)) return;
        var bounds = container.getBoundingClientRect();
        var rect = target.getBoundingClientRect();
        var left = bounds.left + container.clientLeft;
        var top = bounds.top + container.clientTop;
        var width = container.clientWidth;
        var height = container.clientHeight;
        function scrollDelta(start, end, viewportStart, viewportSize) {
          if (end - start > viewportSize) return (start + end - viewportSize) / 2 - viewportStart;
          var margin = Math.min(12, Math.max(0, (viewportSize - (end - start)) / 2));
          if (start < viewportStart + margin) return start - viewportStart - margin;
          if (end > viewportStart + viewportSize - margin) return end - viewportStart - viewportSize + margin;
          return 0;
        }
        container.scrollLeft += scrollDelta(rect.left, rect.right, left, width);
        container.scrollTop += scrollDelta(rect.top, rect.bottom, top, height);
      });
    }
    function revealSelectedLayoutTarget() {
      var selectedId = selectedLayoutPrimaryId();
      if (!selectedId) return;
      var selector = '[data-layout-id="' + cssAttrEscape(selectedId) + '"]';
      var target = output.querySelector('[role="button"]' + selector);
      if (target) revealEditorTarget(target);
    }
    /**
     * Find rendered fragments in the SVG by reading data-layout-fragment-id.
     * Returns array of { id, labelBox, frameBox } where labelBox is the
     * pentagon tab and frameBox is the full enclosing rectangle.
     */
    // ─── Activation bars (sequence execution specifications) ──────────────
    //
    // An activation bar is the thin rectangle on a lifeline showing the span
    // during which an object is active. It is produced by a pair of source
    // lines — `activate X` … `deactivate X` — interleaved with the messages.
    // The bar's top/bottom snap to the messages those directives sit next to,
    // because an execution specification starts and stops at occurrences
    // (messages), not at arbitrary pixels. We model an edge position as a
    // "slot": the number of messages above the directive (slot 0 = above the
    // first message, slot N = below the last). Adjusting "when an object is
    // activated" therefore means moving the `activate` / `deactivate` lines to
    // a different message slot — which is exactly what the drag/keyboard
    // gestures below do. The renderer tags each bar rect with its source line
    // indices so we can map the rendered bar back to the lines to move.

    // Maps a rendered bar id → its source directive lines, so deleteSelected
    // can drop the right `activate`/`deactivate` pair without re-deriving it.
    var activationBarIndex = {};
    // The activation bars of the last drawing, by id.
    function activationBars() { return activationBarIndex; }
    /**
     * Find rendered activation bars in the SVG. Returns
     * { id, startLine, endLine, pIdx, target, box } with box in user space.
     */
    function findRenderedActivationBars(svg) {
      return scene.findRenderedActivationBars(svg, commands.contents().sequenceLines);
    }
    /**
     * Inline SVG icons for the palette buttons. Each icon renders the actual
     * UML notation it produces (solid line + hollow triangle for inheritance,
     * dashed line + hollow triangle for realization, filled diamond for
     * composition, etc.) so the palette reads as a legend the learner can
     * compare against the diagram. Uses currentColor so light + dark mode
     * inherit the button text color automatically.
     *
     * Icons are 28×16px viewBox; CSS sizes them to ~1.4em width. Returns
     * null when there's no SVG for this spec — caller falls back to the
     * unicode glyph in spec.glyph.
     */
    var SVG_NS = 'http://www.w3.org/2000/svg';
    function svgEl(name, attrs) {
      var el = env.document.createElementNS(SVG_NS, name);
      if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
      return el;
    }
    function umlIconFrame() {
      // viewBox padded on all sides so shapes drawn at x=0 / x=28 (diamond
      // tips, arrowheads) keep visual breathing room from the button border
      // — without this they look clipped at high zoom.
      var svg = svgEl('svg', {
        viewBox: '-2 -1 32 18',
        'aria-hidden': 'true',
        focusable: 'false',
        class: 'uml-pg-tool-icon'
      });
      return svg;
    }
    /* Element icons: small UML-style box / circle / dashed-box / lined box.
       Stroke uses currentColor so they invert cleanly in dark mode. */
    function makeElementIcon(spec) {
      var s = spec.id;
      var svg = umlIconFrame();
      if (s === 'class' || s === 'state' || s === 'component' || s === 'node' ||
          s === 'entity' || s === 'action' || s === 'usecase' || s === 'system') {
        // Class-style box: rectangle with header divider.
        svg.appendChild(svgEl('rect', { x: 1, y: 2, width: 26, height: 12, rx: 1.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        svg.appendChild(svgEl('line', { x1: 1, y1: 7, x2: 27, y2: 7, stroke: 'currentColor', 'stroke-width': 1.5 }));
        return svg;
      }
      if (s === 'abstract') {
        // Dashed border to signal abstract.
        svg.appendChild(svgEl('rect', { x: 1, y: 2, width: 26, height: 12, rx: 1.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-dasharray': '3 2' }));
        svg.appendChild(svgEl('line', { x1: 1, y1: 7, x2: 27, y2: 7, stroke: 'currentColor', 'stroke-width': 1.5 }));
        return svg;
      }
      if (s === 'interface' || s === 'provide') {
        // Lollipop-style circle.
        svg.appendChild(svgEl('circle', { cx: 14, cy: 8, r: 5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        return svg;
      }
      if (s === 'require') {
        // Half-circle socket.
        svg.appendChild(svgEl('path', { d: 'M 9 8 a 5 5 0 0 0 10 0', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        return svg;
      }
      if (s === 'enum') {
        svg.appendChild(svgEl('rect', { x: 1, y: 2, width: 26, height: 12, rx: 1.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        svg.appendChild(svgEl('line', { x1: 6, y1: 6, x2: 22, y2: 6, stroke: 'currentColor', 'stroke-width': 1 }));
        svg.appendChild(svgEl('line', { x1: 6, y1: 9, x2: 22, y2: 9, stroke: 'currentColor', 'stroke-width': 1 }));
        svg.appendChild(svgEl('line', { x1: 6, y1: 12, x2: 18, y2: 12, stroke: 'currentColor', 'stroke-width': 1 }));
        return svg;
      }
      if (s === 'note-right' || (spec.isNote)) {
        // Dog-ear note shape.
        svg.appendChild(svgEl('path', { d: 'M 1 2 L 22 2 L 27 7 L 27 14 L 1 14 Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        svg.appendChild(svgEl('path', { d: 'M 22 2 L 22 7 L 27 7', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        return svg;
      }
      if (s === 'actor') {
        // Stick figure: head + body.
        svg.appendChild(svgEl('circle', { cx: 14, cy: 4, r: 2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        svg.appendChild(svgEl('line', { x1: 14, y1: 6, x2: 14, y2: 12, stroke: 'currentColor', 'stroke-width': 1.5 }));
        svg.appendChild(svgEl('line', { x1: 10, y1: 9, x2: 18, y2: 9, stroke: 'currentColor', 'stroke-width': 1.5 }));
        svg.appendChild(svgEl('line', { x1: 14, y1: 12, x2: 11, y2: 15, stroke: 'currentColor', 'stroke-width': 1.5 }));
        svg.appendChild(svgEl('line', { x1: 14, y1: 12, x2: 17, y2: 15, stroke: 'currentColor', 'stroke-width': 1.5 }));
        return svg;
      }
      if (s === 'participant') {
        svg.appendChild(svgEl('rect', { x: 1, y: 2, width: 26, height: 12, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        svg.appendChild(svgEl('line', { x1: 14, y1: 14, x2: 14, y2: 16, stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-dasharray': '1 2' }));
        return svg;
      }
      if (s === 'initial') return (svg.appendChild(svgEl('circle', { cx: 14, cy: 8, r: 4, fill: 'currentColor' })), svg);
      if (s === 'final') {
        svg.appendChild(svgEl('circle', { cx: 14, cy: 8, r: 5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        svg.appendChild(svgEl('circle', { cx: 14, cy: 8, r: 2.5, fill: 'currentColor' }));
        return svg;
      }
      if (s === 'choice' || s === 'decision') {
        svg.appendChild(svgEl('polygon', { points: '14,2 24,8 14,14 4,8', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        return svg;
      }
      if (s === 'composite') {
        svg.appendChild(svgEl('rect', { x: 1, y: 2, width: 26, height: 12, rx: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
        svg.appendChild(svgEl('rect', { x: 5, y: 5, width: 8, height: 6, rx: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 1 }));
        svg.appendChild(svgEl('rect', { x: 15, y: 5, width: 8, height: 6, rx: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 1 }));
        return svg;
      }
      // No SVG icon — fall back to unicode glyph.
      return null;
    }
    /* Relation icons: small UML connector. Uses currentColor for the line
       and the arrow/diamond stroke. Filled shapes (composition, sync) also
       use currentColor for fill. */
    function umlLine(svg, x1, x2, dashed) {
      var l = svgEl('line', { x1: x1, y1: 8, x2: x2, y2: 8, stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' });
      if (dashed) l.setAttribute('stroke-dasharray', '3 2');
      svg.appendChild(l);
    }
    function umlHollowTriangle(svg, atRight) {
      // Hollow triangle pointing right at x=28 (or left at x=0 if !atRight).
      var p = atRight ? '20,3 20,13 28,8' : '8,3 8,13 0,8';
      svg.appendChild(svgEl('polygon', { points: p, fill: 'var(--uml-pg-icon-fill, #fff)', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'miter' }));
    }
    function umlDiamond(svg, filled) {
      // Diamond at left edge.
      svg.appendChild(svgEl('polygon', {
        points: '0,8 5,4 10,8 5,12',
        fill: filled ? 'currentColor' : 'var(--uml-pg-icon-fill, #fff)',
        stroke: 'currentColor',
        'stroke-width': 1.5,
        'stroke-linejoin': 'miter'
      }));
    }
    function umlOpenArrow(svg, atRight, atLeft) {
      if (atRight) {
        svg.appendChild(svgEl('polyline', { points: '22,3 28,8 22,13', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'miter' }));
      }
      if (atLeft) {
        svg.appendChild(svgEl('polyline', { points: '6,3 0,8 6,13', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'miter' }));
      }
    }
    function umlSolidArrow(svg) {
      svg.appendChild(svgEl('polygon', { points: '20,4 28,8 20,12', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 1, 'stroke-linejoin': 'miter' }));
    }
    function makeRelationIcon(spec) {
      var svg = umlIconFrame();
      switch (spec.id) {
        case 'gen':       umlLine(svg, 1, 20, false); umlHollowTriangle(svg, true); return svg;
        case 'real':      umlLine(svg, 1, 20, true);  umlHollowTriangle(svg, true); return svg;
        case 'compose':   umlDiamond(svg, true);  umlLine(svg, 10, 27, false); return svg;
        case 'aggregate': umlDiamond(svg, false); umlLine(svg, 10, 27, false); return svg;
        case 'assoc':     umlLine(svg, 1, 24, false); umlOpenArrow(svg, true, false); return svg;
        case 'biassoc':   umlLine(svg, 5, 23, false); umlOpenArrow(svg, true, true); return svg;
        case 'plain':     umlLine(svg, 1, 27, false); return svg;
        case 'depend':    umlLine(svg, 1, 24, true);  umlOpenArrow(svg, true, false); return svg;
        case 'sync':      umlLine(svg, 1, 22, false); umlSolidArrow(svg); return svg;
        case 'async':     umlLine(svg, 1, 27, false); umlOpenArrow(svg, true, false); return svg;
        case 'return':    umlLine(svg, 1, 27, true);  umlOpenArrow(svg, true, false); return svg;
        case 'create':    umlLine(svg, 1, 22, true);  umlSolidArrow(svg); return svg;
        case 'transition':
        case 'flow':
        case 'arrow':     umlLine(svg, 1, 24, false); umlOpenArrow(svg, true, false); return svg;
        case 'include':
        case 'extend':    umlLine(svg, 1, 24, true);  umlOpenArrow(svg, true, false); return svg;
      }
      return null;
    }
    function makeUmlPaletteIcon(kind, spec) {
      var svg = kind === 'relation' ? makeRelationIcon(spec) : makeElementIcon(spec);
      if (!svg) return null;
      var wrap = env.document.createElement('span');
      wrap.className = 'uml-pg-tool-icon-wrap';
      wrap.setAttribute('aria-hidden', 'true');
      wrap.appendChild(svg);
      return wrap;
    }
    function buildPaletteButton(spec, kind) {
      var btn = env.document.createElement('button');
      btn.type = 'button';
      btn.className = 'uml-pg-tool-btn';
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('data-tool-kind', kind);
      btn.setAttribute('data-tool-spec', spec.id);
      var icon = makeUmlPaletteIcon(kind, spec);
      if (icon) {
        btn.appendChild(icon);
      } else {
        var glyph = env.document.createElement('span');
        glyph.className = 'uml-pg-tool-glyph';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = spec.glyph || '';
        btn.appendChild(glyph);
      }
      btn.appendChild(env.document.createTextNode(spec.label));
      var aria = (kind === 'element' ? 'Add element: ' : 'Add relation: ') + spec.label;
      btn.setAttribute('aria-label', aria);
      btn.setAttribute('data-original-title', aria + ' — click to arm, then click on the diagram. Or drag onto the diagram. Enter or Space adds an element directly.');
      btn.removeAttribute('title');
      // Click-to-arm interaction
      btn.addEventListener('click', function (event) {
        if (paletteDrag.takesClick()) return; // the click that follows a drag is the drag's
        if (kind === 'element' && (event.detail === 0 || !output.querySelector('svg')) && addElementWithoutCanvas(spec)) {
          return;
        }
        if (toolState.activeTool && toolState.activeTool.spec === spec && toolState.activeTool.kind === kind) {
          if (kind === 'element') {
            setActiveTool(kind, spec);
          } else {
            setActiveTool(null);
          }
        } else {
          setActiveTool(kind, spec);
        }
      });
      // Drag-from-palette interaction: the palette drag of the pointer driver.
      btn.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        pointer.press(event, { site: 'palette', button: btn, kind: kind, spec: spec });
      });
      return btn;
    }
    function rebuildPalette() {
      if (!paletteEls || !paletteRels) return;
      paletteEls.textContent = '';
      paletteRels.textContent = '';
      var t = documentType();
      var els = elementSchemasFor(t);
      var rels = relationSchemasFor(t);
      els.forEach(function (s) { paletteEls.appendChild(buildPaletteButton(s, 'element')); });
      rels.forEach(function (s) { paletteRels.appendChild(buildPaletteButton(s, 'relation')); });
    }
    function installSequenceEmptyEditor() {
      var empty = output.querySelector('.uml-empty-msg');
      if (!empty || documentType() !== 'sequence') return;
      empty.textContent = '';
      var panel = env.document.createElement('div');
      panel.className = 'uml-pg-sequence-empty';
      var text = env.document.createElement('p');
      text.textContent = 'No participants yet. Add a lifeline to start the sequence, then connect lifelines with message tools.';
      panel.appendChild(text);
      var actions = env.document.createElement('div');
      actions.className = 'uml-pg-sequence-empty-actions';
      var actorBtn = env.document.createElement('button');
      actorBtn.type = 'button';
      actorBtn.textContent = '+ Actor';
      actorBtn.addEventListener('click', function () { addSequenceParticipant('actor'); });
      var participantBtn = env.document.createElement('button');
      participantBtn.type = 'button';
      participantBtn.textContent = '+ Participant';
      participantBtn.addEventListener('click', function () { addSequenceParticipant('participant'); });
      var starterBtn = env.document.createElement('button');
      starterBtn.type = 'button';
      starterBtn.textContent = '+ Starter exchange';
      starterBtn.addEventListener('click', addSequenceStarterPair);
      actions.appendChild(actorBtn);
      actions.appendChild(participantBtn);
      actions.appendChild(starterBtn);
      panel.appendChild(actions);
      empty.appendChild(panel);
      status.textContent = 'Add an actor or participant to start the sequence diagram.';
    }
    function makeEmptyAction(label, onClick) {
      var btn = env.document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      return btn;
    }
    function installClassOrStateEmptyEditor() {
      var type = documentType();
      if (type !== 'class' && type !== 'state') return;
      var empty = output.querySelector('.uml-empty-msg');
      if (!empty) return;
      empty.textContent = '';
      var panel = env.document.createElement('div');
      panel.className = 'uml-pg-sequence-empty uml-pg-model-empty';
      var text = env.document.createElement('p');
      text.textContent = type === 'class'
        ? 'No classes yet. Add a class, interface, abstract class, or enum to start the model.'
        : 'No states yet. Add a state or starter transition to begin the state machine.';
      panel.appendChild(text);
      var actions = env.document.createElement('div');
      actions.className = 'uml-pg-sequence-empty-actions';
      if (type === 'class') {
        actions.appendChild(makeEmptyAction('+ Class', function () { addEmptyElement('class', 'class'); }));
        actions.appendChild(makeEmptyAction('+ Abstract', function () { addEmptyElement('class', 'abstract'); }));
        actions.appendChild(makeEmptyAction('+ Interface', function () { addEmptyElement('class', 'interface'); }));
        actions.appendChild(makeEmptyAction('+ Enum', function () { addEmptyElement('class', 'enum'); }));
        actions.appendChild(makeEmptyAction('+ Starter hierarchy', addDiagramStarter));
        status.textContent = 'Add a class or interface to start the class diagram.';
      } else {
        actions.appendChild(makeEmptyAction('+ State', function () { addEmptyElement('state', 'state'); }));
        actions.appendChild(makeEmptyAction('+ Composite', function () { addEmptyElement('state', 'composite'); }));
        actions.appendChild(makeEmptyAction('+ Choice', function () { addEmptyElement('state', 'choice'); }));
        actions.appendChild(makeEmptyAction('+ Start transition', addDiagramStarter));
        status.textContent = 'Add a state or transition to start the state machine.';
      }
      panel.appendChild(actions);
      empty.appendChild(panel);
    }
    function installGenericEmptyEditor() {
      var type = documentType();
      if (type === 'sequence') {
        installSequenceEmptyEditor();
        return;
      }
      if (type === 'class' || type === 'state') {
        installClassOrStateEmptyEditor();
        return;
      }
      var empty = output.querySelector('.uml-empty-msg');
      if (!empty || !diagramSupportsCreation(type)) return;
      empty.textContent = '';
      var panel = env.document.createElement('div');
      panel.className = 'uml-pg-sequence-empty uml-pg-model-empty';
      var text = env.document.createElement('p');
      text.textContent = 'No model elements yet. Add an element to start this diagram.';
      panel.appendChild(text);
      var actions = env.document.createElement('div');
      actions.className = 'uml-pg-sequence-empty-actions';
      elementSchemasFor(type).filter(function (spec) {
        return !spec.isNote && !spec.sequenceControl && !spec.sequenceNote;
      }).slice(0, 6).forEach(function (spec) {
        actions.appendChild(makeEmptyAction('+ ' + spec.label, function () {
          addEmptyElement(type, spec.id);
        }));
      });
      panel.appendChild(actions);
      empty.appendChild(panel);
      status.textContent = 'Add an element to start this diagram.';
    }
    function refreshActiveButtonStates() {
      if (!palette) return;
      Array.prototype.slice.call(palette.querySelectorAll('.uml-pg-tool-btn')).forEach(function (btn) {
        var pressed = !!(toolState.activeTool &&
          btn.getAttribute('data-tool-kind') === toolState.activeTool.kind &&
          btn.getAttribute('data-tool-spec') === toolState.activeTool.spec.id);
        btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      });
      if (toolCancel) toolCancel.hidden = !toolState.activeTool && !runningMove;
      var svg = output.querySelector('svg');
      if (svg) {
        svg.classList.toggle('uml-pg-tool-place', !!(toolState.activeTool && toolState.activeTool.kind === 'element'));
        svg.classList.toggle('uml-pg-tool-connect', !!(toolState.activeTool && toolState.activeTool.kind === 'relation'));
      }
      if (previewPane) {
        previewPane.classList.toggle('uml-pg-tool-place', !!(toolState.activeTool && toolState.activeTool.kind === 'element'));
        previewPane.classList.toggle('uml-pg-tool-connect', !!(toolState.activeTool && toolState.activeTool.kind === 'relation'));
      }
    }
    function installExtendHandle(svg, layer, item, hitbox) {
      // Render a circular "+" handle on the right edge, centred vertically.
      var ns = 'http://www.w3.org/2000/svg';
      var compactOffset = Math.min(item.box.width || 0, item.box.height || 0) < 28 ? 14 : 0;
      var hx = item.box.x + item.box.width + compactOffset;
      var hy = item.box.y + item.box.height / 2;
      var g = env.document.createElementNS(ns, 'g');
      g.setAttribute('class', 'uml-pg-extend-handle-group');
      var circle = env.document.createElementNS(ns, 'circle');
      circle.setAttribute('class', 'uml-pg-extend-handle');
      circle.setAttribute('cx', hx);
      circle.setAttribute('cy', hy);
      circle.setAttribute('r', 9);
      circle.setAttribute('tabindex', '0');
      circle.setAttribute('role', 'button');
      circle.setAttribute('aria-label', 'Extend a relation from ' + (item.label || item.id));
      g.appendChild(circle);
      var plus = env.document.createElementNS(ns, 'text');
      plus.setAttribute('class', 'uml-pg-extend-handle-plus');
      plus.setAttribute('x', hx);
      plus.setAttribute('y', hy + 1);
      plus.textContent = '+';
      g.appendChild(plus);
      // Show the handle when hovering either the hitbox OR the handle itself.
      function show() { circle.classList.add('is-visible'); plus.classList.add('is-visible'); }
      function hide() { circle.classList.remove('is-visible'); plus.classList.remove('is-visible'); }
      hitbox.addEventListener('mouseenter', show);
      hitbox.addEventListener('mouseleave', hide);
      circle.addEventListener('mouseenter', show);
      circle.addEventListener('mouseleave', hide);
      hitbox.addEventListener('focus', show);
      hitbox.addEventListener('blur', hide);
      circle.addEventListener('focus', show);
      circle.addEventListener('blur', hide);
      circle.addEventListener('pointerdown', function (ev) {
        pointer.press(ev, { site: 'extend-handle', svg: svg, layer: layer, item: item, hitbox: hitbox, handle: circle, x: hx, y: hy });
      });
      // Keyboard activation on the handle: pressing Enter/Space starts a connect-mode
      // fallback (asks user to click target).
      circle.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          // Use the already selected relation tool, falling back to the first
          // available relation when the handle is used on its own.
          var spec = selectedRelationToolSpec() || relationSchemasFor(documentType())[0];
          if (spec) {
            setActiveTool('relation', spec);
            toolState.pendingRelation = { spec: spec, sourceId: item.id };
            hitbox.classList.add('is-relation-source');
            announce('Press Enter on a target hitbox to connect, or pick a different relation in the palette.', true);
          }
        }
      });
      layer.appendChild(g);
    }
    // The commands that end a running sequence gesture, as the tool's Cancel button and Escape do.
    function cancelSequenceMessageDrag() { pointer.cancel('sequence-message'); }
    function cancelFragmentDrag() { pointer.cancel('fragment'); }
    function cancelActivationBarDrag() { pointer.cancel('activation-bar'); }
    // Tells whether a "+" drag ran.
    function cancelExtendDrag() { return pointer.cancel('extend-handle'); }
    function activationAriaLabel(bar) {
      var who = bar.target || 'object';
      return 'Activation of ' + who + (bar.endLine == null ? ' (open-ended)' : '') +
        ' — Enter to select; Up/Down move the start, Shift+Up/Down the end, Alt+Up/Down the whole bar; Delete to remove';
    }
    /**
     * Build the canvas affordances for every rendered activation bar: a body
     * hitbox (drag to move), top/bottom resize handles (drag to change when the
     * object becomes / stops being active), and a keyboard-focusable target.
     */
    function installActivationBarEditor(svg, layer, targetLayer, visualLayer) {
      var ns = 'http://www.w3.org/2000/svg';
      activationBarIndex = {};
      findRenderedActivationBars(svg).forEach(function (bar) {
        activationBarIndex[bar.id] = { startLine: bar.startLine, endLine: bar.endLine, target: bar.target };
        var box = bar.box;
        var grabW = Math.max(box.width, 12);
        var bx = box.x - (grabW - box.width) / 2;
        var selected = isSelectedAs(bar.id, 'activation');

        var hitbox = env.document.createElementNS(ns, 'rect');
        hitbox.setAttribute('class', 'uml-pg-activation-hitbox' + (selected ? ' is-selected' : ''));
        hitbox.setAttribute('data-layout-id', bar.id);
        hitbox.setAttribute('data-layout-kind', 'activation');
        hitbox.setAttribute('x', bx);
        hitbox.setAttribute('y', box.y);
        hitbox.setAttribute('width', grabW);
        hitbox.setAttribute('height', Math.max(box.height, 6));
        hitbox.setAttribute('aria-hidden', 'true');

        function makeHandle(edge, y) {
          var hh = 8;
          var h = env.document.createElementNS(ns, 'rect');
          h.setAttribute('class', 'uml-pg-activation-handle is-' + edge + (selected ? ' is-selected' : ''));
          h.setAttribute('data-layout-id', bar.id);
          h.setAttribute('x', bx - 3);
          h.setAttribute('width', grabW + 6);
          h.setAttribute('y', y - hh / 2);
          h.setAttribute('height', hh);
          h.setAttribute('aria-hidden', 'true');
          return h;
        }
        var startHandle = makeHandle('start', box.y);
        var endHandle = makeHandle('end', box.y + box.height);

        // Keyboard target — also the WCAG 2.5.8 "equivalent control" for the
        // small drag handles, so keep it at least 24×24 CSS px and centred on
        // the bar even when the bar itself is short.
        var aW = Math.max(grabW + 12, 24);
        var aH = Math.max(box.height + 12, 24);
        var a11y = env.document.createElementNS(ns, 'rect');
        a11y.setAttribute('class', 'uml-pg-edit-a11y-target');
        a11y.setAttribute('data-layout-id', bar.id);
        a11y.setAttribute('x', box.x + box.width / 2 - aW / 2);
        a11y.setAttribute('y', box.y + box.height / 2 - aH / 2);
        a11y.setAttribute('width', aW);
        a11y.setAttribute('height', aH);
        a11y.setAttribute('tabindex', '0');
        a11y.setAttribute('role', 'button');
        a11y.setAttribute('aria-label', activationAriaLabel(bar));
        targetLayer.appendChild(a11y);

        function selectThis(extend) { setSelectedLayoutId(bar.id, 'activation', extend ? { extend: true } : undefined); }
        function bodyPointerDown(ev) {
          pointer.press(ev, { site: 'activation-body', svg: svg, layer: layer, bar: bar });
        }
        hitbox.addEventListener('pointerdown', bodyPointerDown);
        a11y.addEventListener('pointerdown', bodyPointerDown);
        startHandle.addEventListener('pointerdown', function (ev) {
          pointer.press(ev, { site: 'activation-start', svg: svg, layer: layer, bar: bar });
        });
        endHandle.addEventListener('pointerdown', function (ev) {
          pointer.press(ev, { site: 'activation-end', svg: svg, layer: layer, bar: bar });
        });
        function onContext(ev) {
          ev.preventDefault(); ev.stopPropagation(); selectThis(false);
          buildSequenceDetailContextMenu(bar.id, 'activation', ev.clientX, ev.clientY);
        }
        hitbox.addEventListener('contextmenu', onContext);
        a11y.addEventListener('contextmenu', onContext);
        a11y.addEventListener('keydown', function (ev) {
          var k = ev.key;
          if (k === 'Enter' || k === ' ') { ev.preventDefault(); selectThis(false); }
          else if (k === 'ArrowUp' || k === 'ArrowDown') {
            if (toolState.activeTool) return;
            ev.preventDefault();
            var dir = k === 'ArrowUp' ? -1 : 1;
            var which = ev.shiftKey ? 'end' : (ev.altKey ? 'move' : 'start');
            if (!isSelectedAs(bar.id, 'activation')) selectThis(false);
            activationNudge(bar, which, dir);
          }
          else if (k === 'Delete' || k === 'Backspace') {
            ev.preventDefault();
            if (!isSelectedAs(bar.id, 'activation')) selectThis(false);
            deleteSelected();
          }
          else if (k === 'Escape') { ev.preventDefault(); setSelectedLayoutId(null); }
        });

        visualLayer.appendChild(hitbox);
        visualLayer.appendChild(startHandle);
        visualLayer.appendChild(endHandle);
      });
    }
    function installRouteEditor(svg, layer) {
      var routes = findEditableRoutes(svg);
      var ns = 'http://www.w3.org/2000/svg';
      var handleCount = 0;

      routes.forEach(function (route) {
        var lockedEndpoints = routeUsesLockedEndpoints(route);
        var segmentIndices = editableRouteSegmentIndices(route, lockedEndpoints);
        segmentIndices.forEach(function (i) {
          var seg = env.document.createElementNS(ns, 'line');
          seg.setAttribute('class', 'uml-pg-edge-hitbox' + (isPrimarySelection(route.id, 'route') ? ' is-selected' : ''));
          seg.setAttribute('data-layout-id', route.id);
          seg.setAttribute('data-route-id', route.id);
          seg.setAttribute('data-segment-index', String(i));
          seg.setAttribute('data-locked-endpoints', lockedEndpoints ? 'true' : 'false');
          seg.setAttribute('tabindex', '0');
          seg.setAttribute('role', 'button');
          seg.setAttribute('aria-label', 'Relation segment ' + (i + 1) + ' of ' + route.id + ' — Enter to select, Delete to remove');
          setRouteOverlaySegment(seg, route.points[i], route.points[i + 1]);
          seg.addEventListener('pointerdown', function (event) {
            if (event.button !== 0) return;
            pointer.press(event, { site: 'segment', svg: svg, layer: layer, route: route });
          });
          seg.addEventListener('keydown', function (event) {
            if (toolState.activeTool) return;
            var k = event.key;
            if (k === 'Enter' || k === ' ') {
              event.preventDefault();
              setSelectedLayoutId(route.id, 'route');
            } else if (k === 'Delete' || k === 'Backspace') {
              event.preventDefault();
              if (!isSelectedAs(route.id, 'route')) {
                setSelectedLayoutId(route.id, 'route');
              }
              deleteSelected();
            } else if (k === 'Escape') {
              event.preventDefault();
              setSelectedLayoutId(null);
            }
          });
          seg.addEventListener('dblclick', function (event) {
            if (toolState.activeTool) return;
            event.preventDefault();
            event.stopPropagation();
            setSelectedLayoutId(route.id, 'route');
            startInlineRelationEdit(route.id, route.element, event.clientX, event.clientY);
          });
          seg.addEventListener('contextmenu', function (event) {
            event.preventDefault();
            event.stopPropagation();
            setSelectedLayoutId(route.id, 'route');
            buildRouteContextMenu(route.id, event.clientX, event.clientY);
          });
          layer.appendChild(seg);
          handleCount++;
        });
      });

      if (!routes.length || !handleCount) {
        status.textContent = 'No editable lines detected for this diagram yet.';
      } else {
        status.textContent = 'Drag a highlighted line segment.';
      }
    }
    // The placement press: on empty canvas, a press that moves pans the drawing, and a click places the
    // armed element, ends another tool, or clears the selection. Beside the drawing, in the preview pane,
    // a click places the armed element.
    // The hitbox press: a press on a drawn item or a line that selects, toggles, records a tool's click,
    // or starts an in-place edit, and drags nothing. A plain press passes on to the move under it.
    function startHitboxPress(event, press) {
      if (press.site === 'hitbox') return pressOnDrawnItem(event, press);
      if (press.site === 'segment') return pressOnLineSegment(event, press);
      return null;
    }
    function pressOnDrawnItem(event, press) {
      var svg = press.svg;
      var item = press.item;
      var rect = press.rect;
      // In relation-tool mode, click → record source/target instead of drag.
      if (toolState.activeTool && toolState.activeTool.kind === 'relation') {
        // A message tool's press is the sequence message drag, asked before this one.
        if (selectedSequenceMessageToolSpec()) return pressTaken();
        event.preventDefault();
        event.stopPropagation();
        setSelectedLayoutId(item.id, 'node');
        handleHitboxClickForRelation(item, rect);
        return pressTaken();
      }
      // In element-tool mode, click on hitbox is ignored — the user wants
      // to place on empty canvas. Surface a hint.
      if (toolState.activeTool && toolState.activeTool.kind === 'element') {
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget && event.currentTarget.classList &&
            event.currentTarget.classList.contains('uml-pg-edit-a11y-target') &&
            !pointInsideElement(rect, event.clientX, event.clientY)) {
          placeElementAt(toolState.activeTool.spec, editorCanvasPoint(svg, event.clientX, event.clientY));
          return pressTaken();
        }
        if (handleHitboxClickForSequenceElementTool(item)) return pressTaken();
        if (handleHitboxClickForAnchoredNoteTool(item)) return pressTaken();
        announce('Click an empty area to place. Click an existing element to select it instead — switch tools first.', true);
        return pressTaken();
      }
      // Recognise a real user double-click before falling into the
      // drag-vs-click pointerdown path. Capture clientX/Y so the member-
      // text hit test sees the same point the user actually clicked.
      var now = env.now();
      var isDouble = (now - lastHitboxClick.time < 500)
        && lastHitboxClick.itemId === item.id
        && Math.abs(lastHitboxClick.x - event.clientX) < 6
        && Math.abs(lastHitboxClick.y - event.clientY) < 6;
      lastHitboxClick = { time: now, itemId: item.id, x: event.clientX, y: event.clientY };
      if (isDouble) {
        event.preventDefault();
        event.stopPropagation();
        // Reset so a third click starts a fresh window.
        lastHitboxClick = { time: 0, itemId: null, x: 0, y: 0 };
        press.editInPlace(event.clientX, event.clientY);
        return pressTaken();
      }
      event.preventDefault();
      var extend = event.metaKey || event.ctrlKey || event.shiftKey;
      if (extend) {
        // Toggle in selection — no drag.
        setSelectedLayoutId(item.id, 'node', { extend: true });
        return pressTaken();
      }
      return null;
    }
    function pressOnLineSegment(event, press) {
      var route = press.route;
      // Yield to an active tool — element hitbox underneath should handle
      // the click for relation-tool source/target picks.
      if (toolState.activeTool) return null;
      event.preventDefault();
      event.stopPropagation();
      var now = env.now();
      var isDouble = (now - lastRouteClick.time < 500)
        && lastRouteClick.routeId === route.id
        && Math.abs(lastRouteClick.x - event.clientX) < 6
        && Math.abs(lastRouteClick.y - event.clientY) < 6;
      lastRouteClick = { time: now, routeId: route.id, x: event.clientX, y: event.clientY };
      if (isDouble) {
        lastRouteClick = { time: 0, routeId: null, x: 0, y: 0 };
        setSelectedLayoutId(route.id, 'route');
        startInlineRelationEdit(route.id, route.element, event.clientX, event.clientY);
        return pressTaken();
      }
      var extend = event.metaKey || event.ctrlKey || event.shiftKey;
      if (extend) {
        setSelectedLayoutId(route.id, 'route', { extend: true });
        return pressTaken();
      }
      return null;
    }
    function installVisualEditor() {
      // A drawing made while a move runs has ended it (the session's sync said why): its ways in go too, and the
      // reason is said again after what the drawing's cause announces (Undo says "Undone." once it has drawn).
      if (endMoveUi()) {
        env.schedule(function () {
          if (!runningMove) announce(kit.drawingChangedMessage, false);
        }, 0);
      }
      var svg = output.querySelector('svg');
      if (!svg || !editToggle || !editToggle.checked) {
        clearEditLayer();
        host.onSelectionChange(selection());
        refreshActiveButtonStates();
        return false;
      }

      clearEditLayer();
      svg.classList.add('uml-pg-editing');
      installInteractiveSvgSemantics(svg);
      var editables = findEditableElements(svg);
      var ns = 'http://www.w3.org/2000/svg';
      var layer = env.document.createElementNS(ns, 'g');
      layer.setAttribute('class', 'uml-pg-edit-layer');
      svg.appendChild(layer);
      var elementTargetLayer = env.document.createElementNS(ns, 'g');
      elementTargetLayer.setAttribute('class', 'uml-pg-edit-target-layer');
      var elementVisualLayer = env.document.createElementNS(ns, 'g');
      elementVisualLayer.setAttribute('class', 'uml-pg-edit-visual-layer');

      // Restore current pan + zoom on this newly-rendered SVG.
      applyViewTransform(svg);

      // SVG-level contextmenu — show "New element here" / select-all on empty
      // canvas. Hitbox/route handlers above stopPropagation so this only fires
      // when the right-click missed every interactive element.
      svg.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        buildCanvasContextMenu(event.clientX, event.clientY);
      }, { signal: sessionListeners.signal });

      // SVG-level dblclick — handles fragment-label editing for sequence diagrams.
      // Hitbox dblclicks are caught by their own handlers and stop propagation.
      svg.addEventListener('dblclick', function (ev) {
        if (documentType() !== 'sequence') return;
        var t = ev.target;
        if (!t || t.tagName.toLowerCase() !== 'text') return;
        if (t.closest('.uml-pg-edit-layer')) return;
        var routeId = t.getAttribute('data-layout-route-id') ||
          (t.closest('[data-layout-route-id]') ? t.closest('[data-layout-route-id]').getAttribute('data-layout-route-id') : '');
        if (/^seqmsg:\d+$/.test(routeId || '')) {
          ev.preventDefault();
          ev.stopPropagation();
          setSelectedLayoutId(routeId, 'route');
          startInlineRelationEdit(routeId, t, ev.clientX, ev.clientY);
          return;
        }
        // Standalone `[condition]` / `[otherwise]` guard texts are tagged with
        // data-layout-fragment-id (and a role telling us if it's the opener
        // condition or a branch condition).
        var fragId = t.getAttribute('data-layout-fragment-id');
        var fragRole = t.getAttribute('data-layout-fragment-role');
        var branchLine = t.getAttribute('data-layout-branch-line');
        if (fragId && fragRole === 'condition') {
          ev.preventDefault();
          ev.stopPropagation();
          setSelectedLayoutId(fragId, 'fragment');
          startInlineFragmentConditionEdit(t, fragId, null);
          return;
        }
        if (fragId && fragRole === 'branch' && branchLine != null) {
          ev.preventDefault();
          ev.stopPropagation();
          setSelectedLayoutId(fragId, 'fragment');
          startInlineFragmentConditionEdit(t, fragId, Number(branchLine));
          return;
        }
        var content = (t.textContent || '').trim();
        // Match `alt [condition]`, `opt [...]`, `loop [...]`, `par`, `break [...]`,
        // and the `else [...]` separator inside alts.
        var m = content.match(/^(alt|opt|loop|par|break|else)\b(?:\s*\[(.+?)\])?\s*$/i);
        if (!m) return;
        ev.preventDefault();
        ev.stopPropagation();
        startInlineFragmentEdit(t, m[1].toLowerCase(), m[2] || '');
      }, { signal: sessionListeners.signal });

      // Wheel-zoom: Cmd/Ctrl + wheel zooms; pinch-zoom on trackpads also works
      // because it reports as a wheel event with ctrlKey=true.
      svg.addEventListener('wheel', function (ev) {
        if (!ev.ctrlKey && !ev.metaKey) return;
        ev.preventDefault();
        zoomByWheel(ev);
      }, { passive: false, signal: sessionListeners.signal });

      // SVG-level pointerdown handles three things (the placement press):
      //   1. Place-element tool: click on empty canvas → place at cursor.
      //   2. Empty-canvas drag: pan the canvas (start once movement > 5 px).
      //   3. Empty-canvas click without drag: cancel active relation tool / clear selection.
      // A message tool's press on a lifeline and the Activate tool's press come first (their gestures).
      svg.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        // First, if the click landed on a hitbox / edge / handle, ignore — those
        // have their own handlers.
        var target = ev.target;
        var landedOnInteractive = false;
        var landedOnEdgeHitbox = false;
        while (target && target !== svg) {
          if (target.classList && (
              target.classList.contains('uml-pg-edit-a11y-target') ||
              target.classList.contains('uml-pg-edit-hitbox') ||
              target.classList.contains('uml-pg-edge-hitbox') ||
              target.classList.contains('uml-pg-extend-handle') ||
              target.classList.contains('uml-pg-extend-handle-group'))) {
            landedOnInteractive = true;
            landedOnEdgeHitbox = target.classList.contains('uml-pg-edge-hitbox');
            break;
          }
          target = target.parentNode;
        }
        if (landedOnInteractive) {
          if (toolState.activeTool && toolState.activeTool.kind === 'element' && landedOnEdgeHitbox) {
            landedOnInteractive = false;
          }
        }
        pointer.press(ev, { site: 'canvas', svg: svg, layer: layer, landedOnInteractive: landedOnInteractive, landedOnEdgeHitbox: landedOnEdgeHitbox });
      }, { signal: sessionListeners.signal });

      // One unified mode: install relation hitboxes for click-to-edit (label /
      // multiplicity / navigability / stereotype) AND drag-to-reroute, then
      // install element hitboxes for click-to-select / drag-to-move on top.
      installRouteEditor(svg, layer);
      layer.appendChild(elementTargetLayer);
      layer.appendChild(elementVisualLayer);

      editables.sort(function (a, b) {
        function rank(item) {
          if (!item) return 0;
          if (item.axis === 'port') return 3;
          if (item.axis === 'label' || item.axis === 'branch-label') return 2;
          return 1;
        }
        return rank(a) - rank(b);
      });

      editables.forEach(function (item) {
        var targetBox = expandBoxToMinCssTarget(svg, item.box);
        var a11yRect = env.document.createElementNS(ns, 'rect');
        a11yRect.setAttribute('class', 'uml-pg-edit-a11y-target');
        a11yRect.setAttribute('data-layout-id', item.id);
        a11yRect.setAttribute('x', targetBox.x);
        a11yRect.setAttribute('y', targetBox.y);
        a11yRect.setAttribute('width', targetBox.width);
        a11yRect.setAttribute('height', targetBox.height);
        var rect = env.document.createElementNS(ns, 'rect');
        rect.setAttribute('class', 'uml-pg-edit-hitbox' +
          (item.axis === 'port' ? ' is-port' : '') +
          (item.axis === 'branch-label' || item.axis === 'label' ? ' is-label' : '') +
          (item.id === selectedLayoutPrimaryId() ? ' is-selected' : ''));
        rect.setAttribute('data-layout-id', item.id);
        rect.setAttribute('x', item.box.x);
        rect.setAttribute('y', item.box.y);
        rect.setAttribute('width', item.box.width);
        rect.setAttribute('height', item.box.height);
        rect.setAttribute('aria-hidden', 'true');
        var aria = (item.axis === 'port' ? 'Port ' : item.axis === 'label' || item.axis === 'branch-label' ? 'Label ' : 'Element ');
        a11yRect.setAttribute('tabindex', '0');
        a11yRect.setAttribute('role', 'button');
        a11yRect.setAttribute('aria-label', aria + (item.label || item.id) + ' — Enter to select, arrows to nudge, Delete to remove');
        elementTargetLayer.appendChild(a11yRect);
        function addHitboxListener(type, handler) {
          rect.addEventListener(type, handler);
          a11yRect.addEventListener(type, handler);
        }
        // The pointerdown handler below calls preventDefault() to suppress
        // text-selection during drag, which per the Pointer Events spec
        // prevents the browser from firing the compatibility click/dblclick
        // events. Real user double-clicks therefore never reach this listener
        // — only synthetic events do. We keep the listener for synthetic /
        // accessibility paths AND track pointerdown timestamps below to
        // recognise a real user double-click.
        function triggerEditOnDoubleClick(clientX, clientY) {
          if (toolState.activeTool) return;
          // Did the double-click land on a specific class-member text? If so,
          // edit that member inline instead of renaming the whole class.
          if (documentType() === 'class') {
            var memberText = findClassMemberTextAt(svg, item.id, clientX, clientY);
            if (memberText) {
              startInlineMemberEdit(item.id, memberText.index, memberText.textEl);
              return;
            }
          }
          // Resolve the latest item shape (label may have been edited).
          var live = findEditableElements(svg).find(function (e) { return e.id === item.id; }) || item;
          startInlineRename(live);
        }
        addHitboxListener('dblclick', function (event) {
          if (toolState.activeTool) return;
          event.preventDefault();
          event.stopPropagation();
          triggerEditOnDoubleClick(event.clientX, event.clientY);
        });
        addHitboxListener('contextmenu', function (event) {
          event.preventDefault();
          event.stopPropagation();
          // With several things selected, the menu of one of them keeps the selection, so "Move…" moves them all.
          if (!(selectionSize() > 1 && isSelectedAs(item.id, 'node'))) setSelectedLayoutId(item.id, 'node');
          buildElementContextMenu(item, event.clientX, event.clientY);
        });
        // Manual double-click detection (see comment above). preventDefault
        // on pointerdown suppresses the browser's click/dblclick events for
        // this hitbox, so we simulate the double-click recognition window
        // (500 ms, same target, no significant movement between clicks).
        // State is hoisted to `lastHitboxClick` because the editor re-renders
        // hitboxes after the first selection — a per-rect closure would be
        // discarded between the two clicks.
        addHitboxListener('pointerdown', function (event) {
          if (event.button !== 0) return;
          pointer.press(event, { site: 'hitbox', svg: svg, layer: layer, item: item, rect: rect, editables: editables, editInPlace: triggerEditOnDoubleClick });
        });
        // Keyboard activation
        a11yRect.addEventListener('keydown', function (event) {
          var k = event.key;
          if (k === 'Enter' || k === ' ') {
            event.preventDefault();
            if (toolState.activeTool && toolState.activeTool.kind === 'relation') {
              setSelectedLayoutId(item.id, 'node');
              handleHitboxClickForRelation(item, rect);
            } else if (toolState.activeTool && toolState.activeTool.kind === 'element' && handleHitboxClickForSequenceElementTool(item)) {
              setSelectedLayoutId(item.id, 'node');
            } else if (toolState.activeTool && toolState.activeTool.kind === 'element' && handleHitboxClickForAnchoredNoteTool(item)) {
              setSelectedLayoutId(item.id, 'node');
            } else {
              setSelectedLayoutId(item.id, 'node');
            }
          } else if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
            if (toolState.activeTool) return;
            event.preventDefault();
            // 10 px by default (matches the snap-to-grid step the layout
            // engine uses), Shift = 1 px for sub-grid precision. This is the
            // inverse of the splitter's "Shift = coarse 40 px" because the
            // canvas already moves on a grid; users press Shift here to
            // escape the grid, not to take bigger jumps.
            var step = event.shiftKey ? 1 : 10;
            var dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
            var dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
            nudgeElement(item.id, dx, dy);
          } else if (k === 'Delete' || k === 'Backspace') {
            event.preventDefault();
            if (!isSelectedAs(item.id, 'node')) {
              setSelectedLayoutId(item.id, 'node');
            }
            deleteSelected();
          } else if (k === 'F2') {
            event.preventDefault();
            setSelectedLayoutId(item.id, 'node');
            // Selection rebuilds properties synchronously; do not defer focus.
            var firstInput = propsContent && propsContent.querySelector('input[type="text"]');
            if (firstInput) { firstInput.focus(); firstInput.select(); }
          } else if (k === 'Escape') {
            event.preventDefault();
            if (toolState.activeTool) { setActiveTool(null); announce('Cancelled.', false); }
            else { setSelectedLayoutId(null); }
          }
        });
        elementVisualLayer.appendChild(rect);
        // Add hover-to-extend "+" handle for elements (skip ports/labels — they
        // have no clear connect semantics).
        if (documentType() !== 'crc' && item.axis !== 'port' && item.axis !== 'label' && item.axis !== 'branch-label' && item.axis !== 'note') {
          installExtendHandle(svg, layer, item, rect);
        }
      });

      // ─── Fragment hitboxes (sequence diagrams only) ─────────────────
      if (documentType() === 'sequence') {
        findRenderedFragments(svg).forEach(function (frag) {
          var labelBox = frag.labelBox;
          var hitbox = env.document.createElementNS(ns, 'rect');
          hitbox.setAttribute('class', 'uml-pg-edit-hitbox is-label' +
            (isPrimarySelection(frag.id, 'fragment') ? ' is-selected' : ''));
          hitbox.setAttribute('data-layout-id', frag.id);
          hitbox.setAttribute('data-layout-fragment-id', frag.id);
          hitbox.setAttribute('x', labelBox.x);
          hitbox.setAttribute('y', labelBox.y);
          hitbox.setAttribute('width', labelBox.width);
          hitbox.setAttribute('height', labelBox.height);
          hitbox.setAttribute('aria-hidden', 'true');
          var a11y = env.document.createElementNS(ns, 'rect');
          a11y.setAttribute('class', 'uml-pg-edit-a11y-target');
          a11y.setAttribute('data-layout-id', frag.id);
          a11y.setAttribute('x', labelBox.x);
          a11y.setAttribute('y', labelBox.y);
          a11y.setAttribute('width', Math.max(labelBox.width, 36));
          a11y.setAttribute('height', Math.max(labelBox.height, 24));
          a11y.setAttribute('tabindex', '0');
          a11y.setAttribute('role', 'button');
          a11y.setAttribute('aria-label', 'Fragment ' + frag.id + ' — Enter to select, Delete to remove the fragment');
          elementTargetLayer.appendChild(a11y);
          function selectFragment(extend) {
            setSelectedLayoutId(frag.id, 'fragment', extend ? { extend: true } : undefined);
          }
          function onPointerDown(event) {
            pointer.press(event, { site: 'fragment', svg: svg, layer: layer, frag: frag });
          }
          function onContext(event) {
            event.preventDefault();
            event.stopPropagation();
            selectFragment(false);
            buildSequenceDetailContextMenu(frag.id, 'fragment', event.clientX, event.clientY);
          }
          function onKey(event) {
            var k = event.key;
            if (k === 'Enter' || k === ' ') {
              event.preventDefault();
              selectFragment(false);
            } else if (k === 'Delete' || k === 'Backspace') {
              event.preventDefault();
              if (!isSelectedAs(frag.id, 'fragment')) {
                selectFragment(false);
              }
              deleteSelected();
            } else if (k === 'Escape') {
              event.preventDefault();
              setSelectedLayoutId(null);
            }
          }
          function onDblClick(event) {
            if (toolState.activeTool) return;
            event.preventDefault();
            event.stopPropagation();
            selectFragment(false);
            // Give the props pane focus so the user can immediately tab into it.
            var inp = propsContent && propsContent.querySelector('input, select, textarea');
            if (inp) inp.focus();
          }
          hitbox.addEventListener('pointerdown', onPointerDown);
          a11y.addEventListener('pointerdown', onPointerDown);
          hitbox.addEventListener('contextmenu', onContext);
          a11y.addEventListener('contextmenu', onContext);
          hitbox.addEventListener('dblclick', onDblClick);
          a11y.addEventListener('dblclick', onDblClick);
          a11y.addEventListener('keydown', onKey);
          elementVisualLayer.appendChild(hitbox);
        });

        // Activation bars (execution specifications) — drag the body to move,
        // the top/bottom edges to change when the object becomes / stops being
        // active, or use the keyboard to adjust the selected bar.
        installActivationBarEditor(svg, layer, elementTargetLayer, elementVisualLayer);
      }

      if (!editables.length) {
        status.textContent = 'No movable elements detected for this diagram yet.';
      } else {
        status.textContent = toolState.activeTool ? '' : 'Drag a highlighted element. Tab to focus, arrows to nudge, Delete to remove.';
      }
      var ps2 = selectWhenDrawn(null);
      if (ps2) {
        setSelectedLayoutId(ps2.sourceLine == null ? ps2.id : routeIdForSourceLine(svg, ps2.sourceLine), ps2.kind);
      }
      if (toolState.pendingRelation) {
        // The diagram was redrawn mid-gesture: keep the chosen source marked,
        // or forget it if an undo or a text edit removed that element.
        var pendingSource = svg.querySelector('.uml-pg-edit-hitbox[data-layout-id="' + cssAttrEscape(toolState.pendingRelation.sourceId) + '"]');
        if (pendingSource) pendingSource.classList.add('is-relation-source');
        else toolState.pendingRelation = null;
      }
      revealSelectedLayoutTarget();
      refreshActionButton();
      if (revealPending()) {
        var firstTarget = output.querySelector('.uml-pg-edit-a11y-target');
        if (firstTarget) {
          if (!selectedLayoutPrimaryId()) revealEditorTarget(firstTarget);
          setRevealPending(false);
        }
      }
      refreshActiveButtonStates();
      return true;
    }

    // ---------- moves without a drag: the classic surface's ways in (spec §3.11; plan Task 25c) ----------
    //
    // An item's menu offers "Move…", and a line's menu its bends. While a move runs, the pointer over the canvas moves
    // the preview and a click places it; the arrow keys step it (10 px, Shift 1 px, exact) and Enter places it; Escape,
    // the Cancel button, or a press outside the canvas cancels it. The keys are taken before the focused item's own key
    // handler, through the host's key layer. A drawing made while a move runs ends it (the session says why).

    // The side of the "⋯" button, in CSS pixels at every zoom (WCAG 2.5.8 asks for 24).
    var ACTION_BUTTON_CSS_PX = 26;
    // The pointer driver's id of a running move without a drag.
    var MOVE_WITHOUT_DRAG = 'move-without-drag';
    // The running move: { placing, ref, cancelled (what a cancel announces), listening, releaseKeys }, or null.
    var runningMove = null;

    function movingInstruction(what) {
      return 'Moving ' + what + ': click where it should go, or use the arrow keys and press Enter. Escape cancels.';
    }
    // How the move announcements name the drawn line `routeId`.
    function lineLabel(routeId) {
      var svg = output.querySelector('svg');
      var drawn = svg && svg.querySelector('[data-layout-route-id="' + cssAttrEscape(routeId) + '"][data-layout-source]');
      return drawn ? 'the line from ' + drawn.getAttribute('data-layout-source') + ' to ' + drawn.getAttribute('data-layout-target') : routeId;
    }
    // Focus on the item `ref` names in the drawing as it is now: a box's target, or a line's first segment.
    function focusItem(ref) {
      if (ref.kind !== 'route') {
        focusLayoutTarget(ref.id);
        return;
      }
      var segment = output.querySelector('.uml-pg-edge-hitbox[data-route-id="' + cssAttrEscape(ref.id) + '"]');
      if (segment) segment.focus();
    }
    function insideCanvas(event) {
      var canvas = previewPane || output;
      return !!event.target && canvas.contains(event.target);
    }
    function isFormControl(target) {
      var tag = target && target.tagName ? target.tagName.toLowerCase() : '';
      return tag === 'input' || tag === 'textarea' || tag === 'select' || !!(target && target.isContentEditable);
    }
    function showsBends(move) {
      if (move.ref.kind === 'route' && kit.bendNumbers) showBendNumbers();
    }

    /**
     * Runs `placing` (a move started without a press) as the surface's running move of `ref`: the instruction names
     * `what`, a cancel announces `cancelled`. Returns the placing, or null when none started (the session has said why).
     */
    function runMove(placing, ref, what, cancelled) {
      if (!placing) return null;
      var move = { placing: placing, ref: ref, cancelled: cancelled, listening: new AbortController(), releaseKeys: null };
      runningMove = move;
      var pressedInCanvas = false;
      // The pointer over the canvas moves the preview, and a click there places it; the pointer driver hands the
      // move the pointer's moves and its release, as it does a drag's. A release that is no click in the canvas
      // leaves the move running.
      function follow() {
        pointer.hold(MOVE_WITHOUT_DRAG, {
          capture: true,
          move: function (event) {
            if (!insideCanvas(event)) return;
            placing.follow(event);
            showsBends(move);
          },
          end: function (event) {
            var click = pressedInCanvas && insideCanvas(event);
            pressedInCanvas = false;
            if (!click) {
              if (runningMove === move) follow();
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            commitMove(event);
          },
          cancel: function () {}
        });
      }
      follow();
      // A press in the canvas is the click's, not a drag's or a selection's; a press anywhere else cancels.
      env.document.addEventListener('pointerdown', function (event) {
        if (event.button === 0 && insideCanvas(event)) {
          event.preventDefault();
          event.stopPropagation();
          pressedInCanvas = true;
        } else if (!(toolCancel && toolCancel.contains(event.target))) {
          // The Cancel button's own click cancels, so that its words are the move's.
          cancelMove();
        }
      }, { capture: true, signal: move.listening.signal });
      move.releaseKeys = host.registerEscape({ onKey: onMoveKey });
      announce(movingInstruction(what), true);
      refreshActiveButtonStates();
      refreshActionButton();
      focusItem(ref);
      showsBends(move);
      return placing;
    }
    // The keys of a running move, taken before the focused item's own key handler.
    function onMoveKey(event) {
      var move = runningMove;
      if (!move) return;
      var key = event.key;
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelMove();
        return;
      }
      if (isFormControl(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
      if (key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commitMove(null);
      } else if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        // Today's nudge steps: 10 px, Shift 1 px, and never snapped (spec §3.11).
        var step = event.shiftKey ? 1 : 10;
        move.placing.nudge(key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0,
          key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0);
        showsBends(move);
      }
    }
    // Ends the running move's ways in (its listeners, its keys, the Cancel button), leaving what was announced.
    function endMoveUi() {
      var move = runningMove;
      if (!move) return null;
      runningMove = null;
      move.listening.abort();
      pointer.cancel(MOVE_WITHOUT_DRAG);
      if (move.releaseKeys) move.releaseKeys();
      refreshActiveButtonStates();
      return move;
    }
    // Places the running move: at `event`'s point, as a release there would, or, without an event, where the preview
    // is. The announcement is the drag's; focus goes to the moved item in the drawing that follows.
    function commitMove(event) {
      var move = runningMove;
      if (!move) return;
      // The release's point is read before the toolbar loses its Cancel button, which moves the drawing on the page.
      runningMove = null;
      announce('', false);
      var committed = move.placing.commit(event || undefined);
      runningMove = move;
      endMoveUi();
      committed.then(function () {
        focusItem(move.ref);
        refreshActionButton();
      });
    }
    // Cancels the running move: nothing is applied, the preview goes back, and the learner hears that it stays.
    function cancelMove() {
      var move = endMoveUi();
      if (!move) return false;
      move.placing.cancel();
      announce(move.cancelled, false);
      focusItem(move.ref);
      refreshActionButton();
      return true;
    }
    // Starts a move of the box `item` (and the rest of the selection, as its drag would).
    function moveFromMenu(item) {
      if (toolState.activeTool) setActiveTool(null);
      var what = item.label || item.id;
      var ref = { id: item.id, kind: 'node' };
      runMove(startPlacing({ ref: ref }), ref, what, 'Move cancelled; ' + what + ' stays where it was.');
    }
    // Adds a bend to the line `routeId` and starts its move; a cancel takes it away.
    function addBendFromMenu(routeId) {
      if (toolState.activeTool) setActiveTool(null);
      var ref = { id: routeId, kind: 'route' };
      var line = lineLabel(routeId);
      var placing = addBend(ref);
      var n = placing ? placing.target.bend : null;
      runMove(placing, ref, 'bend ' + n + ' of ' + line, 'Move cancelled; ' + line + ' stays as it was.');
    }
    // Starts the move of bend `n` of the line `routeId`.
    function moveBendFromMenu(routeId, n) {
      if (toolState.activeTool) setActiveTool(null);
      var ref = { id: routeId, kind: 'route' };
      var what = 'bend ' + n + ' of ' + lineLabel(routeId);
      runMove(startPlacing({ ref: ref, bend: n }), ref, what, 'Move cancelled; ' + what + ' stays where it was.');
    }
    // Removes bend `n` of the line `routeId`, or all its bends, as one step; focus stays on the line.
    function removeBendFromMenu(routeId, n) {
      var ref = { id: routeId, kind: 'route' };
      removeBend(ref, n).then(function () { focusItem(ref); });
    }
    function straightenFromMenu(routeId) {
      var ref = { id: routeId, kind: 'route' };
      straighten(ref).then(function () { focusItem(ref); });
    }

    // ---------- the "⋯" button (spec §3.11) ----------

    function removeActionButton() {
      Array.prototype.slice.call(output.querySelectorAll('.uml-pg-action-button')).forEach(function (button) { button.remove(); });
    }
    // The client point of drawing point `point` of `svg` (the inverse of editorCanvasPoint).
    function clientPointOf(svg, point) {
      var rect = svg.getBoundingClientRect();
      var box = parseSvgViewBox(svg);
      if (!box || !box.width || !box.height) return { x: rect.left + point.x, y: rect.top + point.y };
      return {
        x: rect.left + ((point.x - box.x) / box.width) * rect.width,
        y: rect.top + ((point.y - box.y) / box.height) * rect.height
      };
    }
    function clientBox(el) {
      var rect = el.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }
    function halfStroke(line) {
      return (parseFloat(env.document.defaultView.getComputedStyle(line).strokeWidth) || 11) / 2;
    }
    // The hit targets of the layer, in client coordinates: boxes, handles, and lines' segments.
    function layerHitTargets(svg, layer) {
      var hits = [];
      Array.prototype.slice.call(layer.querySelectorAll(
        '.uml-pg-edit-a11y-target, .uml-pg-edit-hitbox, .uml-pg-activation-hitbox, .uml-pg-activation-handle, .uml-pg-extend-handle'
      )).forEach(function (el) {
        var box = clientBox(el);
        if (box.width || box.height) hits.push(box);
      });
      Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-edge-hitbox')).forEach(function (line) {
        function end(x, y) { return clientPointOf(svg, { x: Number(line.getAttribute(x)), y: Number(line.getAttribute(y)) }); }
        hits.push({ a: end('x1', 'y1'), b: end('x2', 'y2'), halfWidth: halfStroke(line) });
      });
      return hits;
    }
    // What the button of the one selected item `ref` belongs to: its place target, its name, and how it opens its
    // menu; or null when the item is not drawn as an element or a line.
    function actionSubject(svg, layer, ref) {
      var selector = '[data-layout-id="' + cssAttrEscape(ref.id) + '"]';
      if (ref.kind === 'node') {
        var target = layer.querySelector('.uml-pg-edit-a11y-target' + selector);
        var item = target && findEditableElements(svg).find(function (candidate) { return candidate.id === ref.id; });
        if (!item) return null;
        return {
          target: { box: clientBox(target) },
          label: item.label || item.id,
          focusTarget: target,
          open: function (x, y) { buildElementContextMenu(item, x, y); }
        };
      }
      if (ref.kind === 'route') {
        var segment = layer.querySelector('.uml-pg-edge-hitbox[data-route-id="' + cssAttrEscape(ref.id) + '"]');
        var route = segment && findEditableRoutes(svg).find(function (candidate) { return candidate.id === ref.id; });
        if (!route) return null;
        var points = route.points.map(function (point) { return clientPointOf(svg, point); });
        return {
          target: { points: points, halfWidth: halfStroke(segment) },
          // The numbers drawn at the line's bends are kept clear too.
          bends: points.slice(1, -1).map(function (point) { return { x: point.x - 14, y: point.y - 14, width: 28, height: 28 }; }),
          label: lineLabel(ref.id),
          focusTarget: segment,
          open: function (x, y) { buildRouteContextMenu(ref.id, x, y); }
        };
      }
      return null;
    }
    /**
     * Draws the "⋯" button of the one selected element or line in the hit layer (spec §3.11), or none: not while a
     * drag or a move runs, nor with several things or nothing selected. It is placed by geometry.actionButtonPlace,
     * at ACTION_BUTTON_CSS_PX at every zoom, under the other hit targets when no place is free.
     */
    function refreshActionButton() {
      removeActionButton();
      var svg = output.querySelector('svg');
      var layer = svg && svg.querySelector('.uml-pg-edit-layer');
      if (!layer || runningMove || isDragging()) return;
      var selected = selectedLayout.all();
      if (selected.length !== 1) return;
      var subject = actionSubject(svg, layer, selected[0]);
      if (!subject) return;
      var size = ACTION_BUTTON_CSS_PX;
      var hits = layerHitTargets(svg, layer).concat(subject.bends || []);
      var place = geometry.actionButtonPlace(subject.target, hits, size);
      var from = editorCanvasPoint(svg, place.x, place.y);
      var to = editorCanvasPoint(svg, place.x + size, place.y + size);
      var width = to.x - from.x;
      var height = to.y - from.y;
      var button = svgEl('g', {
        class: 'uml-pg-action-button',
        role: 'button',
        tabindex: '-1',
        'aria-label': 'Actions for ' + subject.label,
        'aria-haspopup': 'menu'
      });
      button.appendChild(svgEl('rect', { class: 'uml-pg-action-button-box', x: from.x, y: from.y, width: width, height: height, rx: width * 0.2 }));
      [0.28, 0.5, 0.72].forEach(function (along) {
        button.appendChild(svgEl('circle', { class: 'uml-pg-action-button-dot', cx: from.x + width * along, cy: from.y + height / 2, r: width * 0.07 }));
      });
      function open(event) {
        event.preventDefault();
        event.stopPropagation();
        var rect = button.getBoundingClientRect();
        // The menu gives focus back to what had it when it opened: the item.
        if (subject.focusTarget.focus) subject.focusTarget.focus();
        subject.open(rect.left, rect.bottom);
      }
      // A press on the button is not a press on the canvas (no pan, no cleared selection).
      button.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
      button.addEventListener('click', open);
      button.addEventListener('contextmenu', open);
      button.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') open(event);
      });
      if (place.free) layer.appendChild(button);
      else layer.insertBefore(button, layer.firstChild);
    }
    // Shift+F10 or the Menu key on a focused diagram item opens its menu, as a right-click there does (spec §3.11).
    function openMenuFromKeys(event) {
      var opens = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
      if (!opens || event.defaultPrevented || runningMove) return;
      var item = event.target;
      if (!item || !item.closest || !item.closest('.uml-pg-edit-layer')) return;
      var button = item.closest('.uml-pg-action-button');
      if (!button && !item.hasAttribute('data-layout-id')) return;
      event.preventDefault();
      closeContextMenu();
      var target = button || item;
      var rect = target.getBoundingClientRect();
      if (button) {
        button.dispatchEvent(new env.document.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
        return;
      }
      item.dispatchEvent(new env.document.defaultView.MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      }));
    }

    // A move, a palette drag, or a sequence gesture that Escape or a switch of edit mode ends. The drags
    // run in the pointer driver, and R0's drag state is each running session's `state`.

    // The record of a running move or route edit until its drop clears it (R0's dragState), or null.
    function heldMove() {
      var move = pointer.running('element-move') || pointer.running('route-edit');
      return move ? move.state : null;
    }
    function isDragging() { return !!(heldMove() || paletteDrag.dropping()); }
    function cancelDrag() {
      paletteDrag.cancelDrop();
      pointer.cancel('element-move');
      pointer.cancel('route-edit');
      clearSmartGuides();
      host.redraw();
      announce('Cancelled.', false);
    }
    function cancelSequenceGesture() {
      if (pointer.cancel('sequence-message')) {
        announce('Cancelled.', false);
        return true;
      }
      if (pointer.cancel('fragment')) {
        announce('Cancelled.', false);
        return true;
      }
      if (pointer.cancel('activation-bar')) {
        announce('Cancelled.', false);
        return true;
      }
      return false;
    }
    function stopEditing() {
      cancelMove();
      pointer.cancel('element-move');
      pointer.cancel('route-edit');
      cancelSequenceMessageDrag();
      cancelFragmentDrag();
      cancelActivationBarDrag();
      cancelExtendDrag();
      setSelectedLayoutId(null);
      setActiveTool(null);
      clearEditLayer();
    }

    // Takes the surface off the page when its session is destroyed (spec §2.4): the hit layer, the palette's buttons,
    // and the status line's instruction go, and the drawing gets back its own role, name, and class attribute. (The
    // surface's listeners go with the session's abort signal.)
    function removeSurface() {
      endMoveUi();
      clearEditLayer();
      var svg = output.querySelector('svg');
      if (svg && svg.getAttribute('class') === '') svg.removeAttribute('class');
      if (paletteEls) paletteEls.textContent = '';
      if (paletteRels) paletteRels.textContent = '';
      status.textContent = '';
    }

    // The listeners the classic surface keeps for the session's whole life, added once the pointer driver exists.
    function installSessionListeners() {
      // The preview pane is a press site, bound once (outside installVisualEditor, which rebinds on every
      // render) because the preview container persists across renders: beside the drawing an armed element
      // tool places, and Shift+drag draws a marquee wherever in the canvas it begins (some renderers
      // collapse the SVG's getBoundingClientRect to 0×0 while painting content outside it).
      if (previewPane) {
        previewPane.addEventListener('pointerdown', function (ev) {
          if (ev.button !== 0) return;
          pointer.press(ev, { site: 'preview' });
        }, { signal: sessionListeners.signal });
      }
      output.addEventListener('focusin', function (event) {
        var target = event.target;
        if (target && target.closest && target.closest('svg')) {
          revealEditorTarget(target);
        }
      }, { signal: sessionListeners.signal });
      output.addEventListener('keydown', function (event) {
        // Selection can open the properties pane and narrow the canvas after the
        // focus event. Run after the target's keyboard handler has updated it.
        if (event.target && event.target.hasAttribute('data-layout-id')) revealSelectedLayoutTarget();
      }, { signal: sessionListeners.signal });
      output.addEventListener('keydown', openMenuFromKeys, { signal: sessionListeners.signal });
      if (toolCancel) {
        toolCancel.addEventListener('click', function () {
          if (cancelMove()) return;
          cancelSequenceMessageDrag();
          cancelFragmentDrag();
          cancelActivationBarDrag();
          setActiveTool(null);
          announce('Cancelled.', false);
        }, { signal: sessionListeners.signal });
      }
      // Capture before canvas handlers prevent native focus or stop propagation.
      // A pointer selection must own the next key, even after editing a text field
      // or focusing a different diagram item.
      if (previewPane) {
        previewPane.addEventListener('pointerdown', function (event) {
          if (event.button !== 0) return;
          var target = event.target;
          if (target.closest('a[href], button, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
          var focusTarget = target.closest('[tabindex]') || previewPane;
          focusTarget.focus({ preventScroll: true });
        }, { capture: true, signal: sessionListeners.signal });
      }
    }

    return {
      members: {
        activationBars: activationBars,
        addBendFromMenu: addBendFromMenu,
        cancelActivationBarDrag: cancelActivationBarDrag,
        cancelDrag: cancelDrag,
        cancelFragmentDrag: cancelFragmentDrag,
        cancelExtendDrag: cancelExtendDrag,
        cancelSequenceGesture: cancelSequenceGesture,
        cancelSequenceMessageDrag: cancelSequenceMessageDrag,
        clearEditLayer: clearEditLayer,
        installGenericEmptyEditor: installGenericEmptyEditor,
        installSessionListeners: installSessionListeners,
        installVisualEditor: installVisualEditor,
        isDragging: isDragging,
        moveBendFromMenu: moveBendFromMenu,
        moveFromMenu: moveFromMenu,
        rebuildPalette: rebuildPalette,
        refreshActionButton: refreshActionButton,
        refreshActiveButtonStates: refreshActiveButtonStates,
        removeBendFromMenu: removeBendFromMenu,
        removeSurface: removeSurface,
        startHitboxPress: startHitboxPress,
        stopEditing: stopEditing,
        straightenFromMenu: straightenFromMenu
      },
      link: function () {
        activationNudge = kit.activationNudge;
        addBend = kit.addBend;
        addDiagramStarter = kit.addDiagramStarter;
        addElementWithoutCanvas = kit.addElementWithoutCanvas;
        addEmptyElement = kit.addEmptyElement;
        addSequenceParticipant = kit.addSequenceParticipant;
        addSequenceStarterPair = kit.addSequenceStarterPair;
        announce = kit.announce;
        applyViewTransform = kit.applyViewTransform;
        buildCanvasContextMenu = kit.buildCanvasContextMenu;
        buildElementContextMenu = kit.buildElementContextMenu;
        buildRouteContextMenu = kit.buildRouteContextMenu;
        buildSequenceDetailContextMenu = kit.buildSequenceDetailContextMenu;
        clearSmartGuides = kit.clearSmartGuides;
        closeContextMenu = kit.closeContextMenu;
        deleteSelected = kit.deleteSelected;
        documentType = kit.documentType;
        editorCanvasPoint = kit.editorCanvasPoint;
        expandBoxToMinCssTarget = kit.expandBoxToMinCssTarget;
        findClassMemberTextAt = kit.findClassMemberTextAt;
        handleHitboxClickForAnchoredNoteTool = kit.handleHitboxClickForAnchoredNoteTool;
        handleHitboxClickForRelation = kit.handleHitboxClickForRelation;
        handleHitboxClickForSequenceElementTool = kit.handleHitboxClickForSequenceElementTool;
        nudgeElement = kit.nudgeElement;
        paletteDrag = kit.paletteDrag;
        parseSvgViewBox = kit.parseSvgViewBox;
        placeElementAt = kit.placeElementAt;
        pointInsideElement = kit.pointInsideElement;
        pointer = kit.pointer;
        pressTaken = kit.pressTaken;
        revealPending = kit.revealPending;
        routeIdForSourceLine = kit.routeIdForSourceLine;
        routeUsesLockedEndpoints = kit.routeUsesLockedEndpoints;
        selectedRelationToolSpec = kit.selectedRelationToolSpec;
        selectedSequenceMessageToolSpec = kit.selectedSequenceMessageToolSpec;
        setActiveTool = kit.setActiveTool;
        setRevealPending = kit.setRevealPending;
        setRouteOverlaySegment = kit.setRouteOverlaySegment;
        showBendNumbers = kit.showBendNumbers;
        startPlacing = kit.startPlacing;
        startInlineFragmentConditionEdit = kit.startInlineFragmentConditionEdit;
        startInlineFragmentEdit = kit.startInlineFragmentEdit;
        startInlineMemberEdit = kit.startInlineMemberEdit;
        startInlineRelationEdit = kit.startInlineRelationEdit;
        startInlineRename = kit.startInlineRename;
        straighten = kit.straighten;
        removeBend = kit.removeBend;
        toolState = kit.toolState;
        zoomByWheel = kit.zoomByWheel;
      }
    };
  }

  return { createClassicPointerDriver: createClassicPointerDriver, createClassicSurface: createClassicSurface };
});
