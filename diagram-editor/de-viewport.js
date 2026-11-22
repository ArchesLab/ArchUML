(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./de-scene.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.viewport) parts.viewport = factory(parts.scene);
  }
})(typeof self !== 'undefined' ? self : this, function (scene) {
  'use strict';

  // The view of a session (UML-view editing spec §2.2, §3.3; plan Task 23): the canvas's bounds, the pan and zoom of
  // the drawing, the conversion of a pointer's position into the drawing's own coordinates, and whether the next
  // drawing brings its first target into view. It owns the zoom, the pan, and that flag; nothing else changes them.
  //
  // The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
  // (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession): it takes the
  // values and the session's functions it uses when it is made, and what it uses of the other parts when the session
  // calls its link(), once every part and the pointer driver exist. Its members join the kit.
  // The zoom readout and its buttons are `kit.elements` (zoomReadout, zoomIn, zoomOut), which the readout read
  // from the session's options before.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var clientRectToSvgBox = scene.clientRectToSvgBox;
  var safeBBox = scene.safeBBox;
  var svgPoint = scene.svgPoint;

  // The drawing's own size and view box while it is an editor canvas: applyEditorCanvasBounds remembers each attribute
  // in a data attribute before it changes it, and an export of the drawing puts the attributes back. Moved from the top
  // level of the inline script of _includes/uml-editor.html by plan Task 24, without a changed statement.
  function rememberExportAttribute(svg, name) {
    var suffix = name.toLowerCase();
    svg.setAttribute('data-uml-pg-export-had-' + suffix, svg.hasAttribute(name) ? '1' : '0');
    svg.setAttribute('data-uml-pg-export-' + suffix, svg.getAttribute(name) || '');
  }
  function restoreExportAttribute(svg, name) {
    var suffix = name.toLowerCase();
    var hadName = 'data-uml-pg-export-had-' + suffix;
    var valueName = 'data-uml-pg-export-' + suffix;
    if (!svg.hasAttribute(hadName)) return;
    var hadAttr = svg.getAttribute(hadName) === '1';
    var value = svg.getAttribute(valueName) || '';
    if (hadAttr) svg.setAttribute(name, value);
    else svg.removeAttribute(name);
    svg.removeAttribute(hadName);
    svg.removeAttribute(valueName);
  }
  function restoreExportCanvasBounds(svg) {
    if (!svg) return;
    restoreExportAttribute(svg, 'viewBox');
    restoreExportAttribute(svg, 'width');
    restoreExportAttribute(svg, 'height');
    svg.removeAttribute('data-uml-pg-editor-canvas');
  }

  /**
   * The view of the drawing in `kit.output`, with `kit.env` and the page elements `kit.elements`. Besides the moved
   * functions, `level()` is the zoom and `set({ zoom, pan })` sets a view as a whole (for a host that keeps one).
   */
  function createViewport(kit) {
    // What the session made this part with.
    var elements = kit.elements;
    var env = kit.env;
    var output = kit.output;

    var EDITOR_CANVAS_MIN_WIDTH = 960;
    var EDITOR_CANVAS_MIN_HEIGHT = 620;
    var EDITOR_CANVAS_PADDING = 96;
    var EDITOR_MIN_TARGET_CSS_PX = 28;
    function numericSvgLength(value) {
      var m = String(value || '').trim().match(/^-?\d+(?:\.\d+)?/);
      if (!m) return null;
      var n = Number(m[0]);
      return isFinite(n) ? n : null;
    }
    function formatViewBoxNumber(value) {
      var rounded = Math.round(value * 100) / 100;
      return String(Object.is(rounded, -0) ? 0 : rounded);
    }
    function formatViewBox(box) {
      return [
        formatViewBoxNumber(box.x),
        formatViewBoxNumber(box.y),
        formatViewBoxNumber(box.width),
        formatViewBoxNumber(box.height)
      ].join(' ');
    }
    function parseSvgViewBox(svg) {
      var raw = svg.getAttribute('viewBox');
      if (raw) {
        var parts = raw.trim().split(/[\s,]+/).map(Number);
        if (parts.length >= 4 &&
            parts.every(function (n) { return isFinite(n); }) &&
            parts[2] > 0 && parts[3] > 0) {
          return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        }
      }

      var width = numericSvgLength(svg.getAttribute('width'));
      var height = numericSvgLength(svg.getAttribute('height'));
      if (width && height) return { x: 0, y: 0, width: width, height: height };

      return safeBBox(svg.querySelector('g') || svg);
    }
    function applyEditorCanvasBounds(svg) {
      if (!svg || svg.getAttribute('data-uml-pg-editor-canvas') === '1') return;
      var box = parseSvgViewBox(svg);
      if (!box) return;

      rememberExportAttribute(svg, 'viewBox');
      rememberExportAttribute(svg, 'width');
      rememberExportAttribute(svg, 'height');

      var contentBox = safeBBox(svg.querySelector('g') || svg);
      var contentLeft = contentBox ? Math.min(box.x, contentBox.x) : box.x;
      var contentTop = contentBox ? Math.min(box.y, contentBox.y) : box.y;
      var contentRightEdge = contentBox ? Math.max(box.x + box.width, contentBox.x + contentBox.width) : box.x + box.width;
      var contentBottomEdge = contentBox ? Math.max(box.y + box.height, contentBox.y + contentBox.height) : box.y + box.height;
      var left = Math.min(0, contentLeft - EDITOR_CANVAS_PADDING);
      var top = Math.min(0, contentTop - EDITOR_CANVAS_PADDING);
      var contentRight = contentRightEdge + EDITOR_CANVAS_PADDING;
      var contentBottom = contentBottomEdge + EDITOR_CANVAS_PADDING;
      var right = Math.max(contentRight, left + EDITOR_CANVAS_MIN_WIDTH);
      var bottom = Math.max(contentBottom, top + EDITOR_CANVAS_MIN_HEIGHT);
      var canvas = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top
      };

      svg.setAttribute('viewBox', formatViewBox(canvas));
      svg.setAttribute('width', String(Math.ceil(canvas.width)));
      svg.setAttribute('height', String(Math.ceil(canvas.height)));
      svg.setAttribute('data-uml-pg-editor-canvas', '1');
      // The shared renderer sized the original viewBox. Recalculate its
      // paragraph-relative width after adding the editor's blank canvas.
      if (env.bundle.UMLShared && env.bundle.UMLShared.autoFitSVG) {
        env.bundle.UMLShared.autoFitSVG(output);
      }
    }
    function svgUnitsForCssPixels(svg, cssPx) {
      var ctm = svg && svg.getScreenCTM ? svg.getScreenCTM() : null;
      var scaleX = Math.abs(ctm && ctm.a ? ctm.a : 1);
      var scaleY = Math.abs(ctm && ctm.d ? ctm.d : 1);
      return {
        width: cssPx / (scaleX || 1),
        height: cssPx / (scaleY || 1)
      };
    }
    function expandBoxToMinCssTarget(svg, box) {
      var min = svgUnitsForCssPixels(svg, EDITOR_MIN_TARGET_CSS_PX);
      var width = Math.max(box.width, min.width);
      var height = Math.max(box.height, min.height);
      return {
        x: box.x - (width - box.width) / 2,
        y: box.y - (height - box.height) / 2,
        width: width,
        height: height
      };
    }
    function svgPointFromEvent(svg, ev) { return svgPoint(svg, ev.clientX, ev.clientY); }
    function editorCanvasPoint(svg, clientX, clientY) {
      if (!svg || !svg.getBoundingClientRect) return { x: clientX, y: clientY };
      var rect = svg.getBoundingClientRect();
      var box = parseSvgViewBox(svg);
      if (!box || rect.width <= 0 || rect.height <= 0) return svgPoint(svg, clientX, clientY);
      return {
        x: box.x + ((clientX - rect.left) / rect.width) * box.width,
        y: box.y + ((clientY - rect.top) / rect.height) * box.height
      };
    }
    function clientRectToEditorCanvasBox(svg, rect) {
      var p1 = editorCanvasPoint(svg, rect.left, rect.top);
      var p2 = editorCanvasPoint(svg, rect.right, rect.bottom);
      var x = Math.min(p1.x, p2.x);
      var y = Math.min(p1.y, p2.y);
      return { x: x, y: y, width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y) };
    }
    // ─── Canvas pan + zoom ───
    // panOffset and zoom survive re-renders (we re-apply them after each render)
    // but do not survive page reloads.
    var panOffset = { x: 0, y: 0 };
    var zoom = 1;
    var initialCanvasRevealPending = true;
    // Whether the next editable drawing brings its first target into view (a new view, a new diagram type).
    function revealPending() { return initialCanvasRevealPending; }
    function setRevealPending(flag) { initialCanvasRevealPending = flag; }
    var ZOOM_MIN = 0.2;
    var ZOOM_MAX = 5;
    // The canvas scales from its top-left corner: css/tutorial-uml-editor.css gives the drawing
    // transform-origin 0 0, which zoomAt's arithmetic assumes.
    function applyViewTransform(svg) {
      if (!svg) return;
      if (panOffset.x === 0 && panOffset.y === 0 && zoom === 1) {
        svg.style.removeProperty('transform');
      } else {
        svg.style.transform = 'translate(' + panOffset.x + 'px,' + panOffset.y + 'px) scale(' + zoom + ')';
      }
      updateZoomReadout();
      // The classic surface's "⋯" button keeps its size in CSS pixels at every zoom (spec §3.11), so it is placed again.
      if (kit.refreshActionButton) kit.refreshActionButton();
    }
    // Backwards-compat alias — older call sites still use applyPanTransform.
    var applyPanTransform = applyViewTransform;
    function resetView() {
      panOffset.x = 0; panOffset.y = 0; zoom = 1;
      initialCanvasRevealPending = true;
      var svg = output.querySelector('svg');
      if (svg) applyViewTransform(svg);
    }
    var resetPan = resetView; // keep old name available
    /**
     * Zoom by a multiplicative factor anchored at a viewport position so the
     * point under the cursor / button stays visually fixed.
     * @param {number} factor   e.g. 1.2 to zoom in, 1/1.2 to zoom out.
     * @param {number} clientX  Viewport X to keep stationary. Defaults to viewport center of SVG.
     * @param {number} clientY  Viewport Y to keep stationary.
     */
    function zoomAt(factor, clientX, clientY) {
      var svg = output.querySelector('svg');
      if (!svg) return;
      var oldZoom = zoom;
      var newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, oldZoom * factor));
      if (Math.abs(newZoom - oldZoom) < 1e-6) return;
      var rect = svg.getBoundingClientRect();
      // If no anchor was given, anchor on the SVG's viewport centre.
      if (clientX == null) clientX = rect.left + rect.width / 2;
      if (clientY == null) clientY = rect.top + rect.height / 2;
      // Convert cursor to pre-transform local coords. With transform-origin 0 0:
      //   screen = layoutOrigin + pan + local * zoom
      // The current visual rect.left already equals layoutOrigin + pan. So:
      var localX = (clientX - rect.left) / oldZoom;
      var localY = (clientY - rect.top) / oldZoom;
      // Compensate pan so localX/localY map back to the same screen point at newZoom.
      panOffset.x -= localX * (newZoom - oldZoom);
      panOffset.y -= localY * (newZoom - oldZoom);
      zoom = newZoom;
      applyViewTransform(svg);
    }
    function zoomIn(clientX, clientY) { zoomAt(1.2, clientX, clientY); }
    function zoomOut(clientX, clientY) { zoomAt(1 / 1.2, clientX, clientY); }
    function zoomToFit() {
      // Reset pan + zoom — the renderer's intrinsic SVG fits its container.
      resetView();
    }
    function updateZoomReadout() {
      var el = elements.zoomReadout;
      if (el) el.textContent = Math.round(zoom * 100) + '%';
      var zin = elements.zoomIn;
      var zout = elements.zoomOut;
      if (zin) zin.disabled = zoom >= ZOOM_MAX - 1e-6;
      if (zout) zout.disabled = zoom <= ZOOM_MIN + 1e-6;
    }
    // The zoom, and a view set as a whole: `{ zoom, pan: { x, y } }`, the zoom kept within its limits.
    function level() { return zoom; }
    function set(view) {
      zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.zoom));
      panOffset.x = view.pan.x;
      panOffset.y = view.pan.y;
      applyViewTransform(output.querySelector('svg'));
    }

    return {
      members: {
        applyEditorCanvasBounds: applyEditorCanvasBounds,
        applyPanTransform: applyPanTransform,
        applyViewTransform: applyViewTransform,
        clientRectToEditorCanvasBox: clientRectToEditorCanvasBox,
        editorCanvasPoint: editorCanvasPoint,
        expandBoxToMinCssTarget: expandBoxToMinCssTarget,
        level: level,
        panOffset: panOffset,
        parseSvgViewBox: parseSvgViewBox,
        resetView: resetView,
        revealPending: revealPending,
        set: set,
        setRevealPending: setRevealPending,
        updateZoomReadout: updateZoomReadout,
        zoomAt: zoomAt,
        zoomIn: zoomIn,
        zoomOut: zoomOut,
        zoomToFit: zoomToFit
      }
    };
  }

  /**
   * The view of a session whose host owns it (`viewport: 'host'`, spec §7.2; plan Task 38): the host sizes, pans, and
   * zooms the drawing, so this part changes none of it and keeps no zoom. A pointer's place maps into the drawing's
   * coordinates through the drawing's screen CTM, which holds whatever transform the host applies, and a hit target
   * is grown to the least size on the screen as it is now, the module's own view's rule. The members the classic
   * surface alone calls (the zoom buttons, the pan) are not here.
   */
  function createHostViewport(kit) {
    var moduleView = createViewport(kit).members;
    function editorCanvasPoint(svg, clientX, clientY) {
      return svg ? svgPoint(svg, clientX, clientY) : { x: clientX, y: clientY };
    }
    function hostOwnsIt() {}
    return {
      members: {
        applyEditorCanvasBounds: hostOwnsIt,
        applyPanTransform: hostOwnsIt,
        applyViewTransform: hostOwnsIt,
        clientRectToEditorCanvasBox: clientRectToSvgBox,
        editorCanvasPoint: editorCanvasPoint,
        expandBoxToMinCssTarget: moduleView.expandBoxToMinCssTarget,
        // The drawing's own extent, which the sequence gestures read (plan Task 42): read only, never set here.
        parseSvgViewBox: moduleView.parseSvgViewBox,
        revealPending: function () { return false; },
        setRevealPending: hostOwnsIt,
        updateZoomReadout: hostOwnsIt
      }
    };
  }

  return { createViewport: createViewport, createHostViewport: createHostViewport, restoreExportCanvasBounds: restoreExportCanvasBounds };
});
