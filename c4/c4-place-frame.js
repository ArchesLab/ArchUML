(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4PlaceParts = root.ArchUMLC4PlaceParts || {};
    parts.frame = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The geometry every placement step shares (routing redesign §3.3, §4.1): the placement constants, the flow frame
  // that placement runs in, and the room a boundary keeps around its members. `CFG` is the one source of these
  // constants: c4-place.js publishes it as `ArchUMLC4Place.CFG`, and the renderer's seed and boundary labels read it
  // there. Pure and DOM-free, with no dependency.

  // Placement constants (routing redesign §3.3), in diagram units.
  const CFG = Object.freeze({
    levelGapX: 90,
    levelGapY: 110,
    boundaryPad: 30,
    boundaryBand: 30,
    slotPitch: 40,
    cornerMargin: 24,
    maxHeadsPerSide: 2,
    tailStub: 18,
    headStub: 30,
    trackPitch: 24,
    boxClearance: 20,
    laneClearance: 32,
    labelBesideGap: 6,
    labelForeignClear: 12,
    labelBoxClear: 8,
    maxStretch: 900,
    exhaustiveOrderMax: 7,
    maxOrderSweeps: 12,
  });

  // ---- Frame (§4.1) ---------------------------------------------------------------------------------------

  // Placement runs in a flow frame: `main` is the flow axis and `cross` the axis across it. The engine transforms the
  // graph in once and the boxes out once; `frameAxes` is the only code that reads the direction.

  /** Which frame axis each real axis is: down, x is cross and y is main; to the right, the other way round. */
  function frameAxes(direction) {
    if (direction !== 'down' && direction !== 'right') throw new Error('C4 placement: unknown direction "' + direction + '"');
    return direction === 'right' ? { x: 'main', y: 'cross' } : { x: 'cross', y: 'main' };
  }

  /**
   * The room a boundary keeps around its members' extents `inner` ({main, cross}), per side of the frame. The
   * label line sits at the boundary's bottom-left in real coordinates: its height adds to the side after the
   * members on the real y axis, and its width bounds the extent on the real x axis from below.
   */
  function frameExtents(inner, labelWidth, labelHeight, direction) {
    const axes = frameAxes(direction);
    const extents = { mainBefore: CFG.boundaryPad, mainAfter: CFG.boundaryPad, crossBefore: CFG.boundaryPad, crossAfter: CFG.boundaryPad };
    extents[axes.y + 'After'] += labelHeight;
    extents[axes.x + 'After'] += Math.max(0, labelWidth - inner[axes.x]);
    return extents;
  }

  /** A real rectangle `{x, y, width, height}` as `{cross, main, crossSize, mainSize}`. */
  function rectInFrame(rect, axes) {
    const frame = {};
    frame[axes.x] = rect.x;
    frame[axes.y] = rect.y;
    frame[axes.x + 'Size'] = rect.width;
    frame[axes.y + 'Size'] = rect.height;
    return frame;
  }

  function rectInReal(frame, axes) {
    return { x: frame[axes.x], y: frame[axes.y], width: frame[axes.x + 'Size'], height: frame[axes.y + 'Size'] };
  }

  /** The graph with every size rounded up to an integer (§7), still in real coordinates. */
  function roundedGraph(graph) {
    return {
      items: graph.items.map((item) => Object.assign({}, item, { width: Math.ceil(item.width), height: Math.ceil(item.height) })),
      boundaries: graph.boundaries.map((boundary) => Object.assign({}, boundary, {
        labelWidth: Math.ceil(boundary.labelWidth || 0), labelHeight: Math.ceil(boundary.labelHeight || 0),
      })),
      edges: graph.edges.map((edge) => Object.assign({}, edge, {
        labelWidth: Math.ceil(edge.labelWidth || 0), labelHeight: Math.ceil(edge.labelHeight || 0),
      })),
      scopeId: graph.scopeId || null,
    };
  }

  /** The graph in the frame: an item's width is its cross extent and its height its main extent; so are labels. */
  function graphInFrame(graph, axes) {
    const sized = (width, height) => rectInFrame({ x: 0, y: 0, width: width, height: height }, axes);
    return Object.assign({}, graph, {
      items: graph.items.map((item) => {
        const frame = sized(item.width, item.height);
        return Object.assign({}, item, { width: frame.crossSize, height: frame.mainSize });
      }),
      edges: graph.edges.map((edge) => {
        const frame = sized(edge.labelWidth, edge.labelHeight);
        return Object.assign({}, edge, { labelCross: frame.crossSize, labelMain: frame.mainSize });
      }),
    });
  }

  /** A real rectangle as its `main` and `cross` ranges in the frame. */
  function frameRanges(rect, axes) {
    const frame = rectInFrame(rect, axes);
    return { main: [frame.main, frame.main + frame.mainSize], cross: [frame.cross, frame.cross + frame.crossSize] };
  }

  // ---- Boundaries around their members (§4.7) -------------------------------------------------------------------

  /** The box `{x, y, width, height}` that just holds `boxes`. */
  function boundsOf(boxes) {
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    return {
      x: left, y: top,
      width: Math.max(...boxes.map((box) => box.x + box.width)) - left, height: Math.max(...boxes.map((box) => box.y + box.height)) - top,
    };
  }

  // Real coordinates are the frame of the direction 'down' (x across the flow, y along it); in them, a boundary's
  // label line always lies below its members, whatever the flow direction.

  /**
   * The real box of a boundary around `children` (`{x, y, width, height}` boxes): the room `frameExtents` keeps on
   * every side, so padding all round, the label line below, and at least the label wide. The seed (c4-render.js)
   * and the settle step frame with it.
   */
  function frameAround(boundary, children) {
    const inner = boundsOf(children);
    const room = frameExtents({ main: inner.height, cross: inner.width }, boundary.labelWidth, boundary.labelHeight, 'down');
    return {
      x: inner.x - room.crossBefore, y: inner.y - room.mainBefore,
      width: room.crossBefore + inner.width + room.crossAfter, height: room.mainBefore + inner.height + room.mainAfter,
    };
  }

  /** The part of a boundary's real box that its members may use: the box without the padding and the label line. */
  function interiorOf(boundary, box) {
    const room = frameExtents({ main: Infinity, cross: Infinity }, boundary.labelWidth, boundary.labelHeight, 'down');
    return {
      x: box.x + room.crossBefore, y: box.y + room.mainBefore,
      width: box.width - room.crossBefore - room.crossAfter, height: box.height - room.mainBefore - room.mainAfter,
    };
  }

  return {
    CFG: CFG, frameAxes: frameAxes, frameExtents: frameExtents, rectInFrame: rectInFrame, rectInReal: rectInReal,
    frameRanges: frameRanges, roundedGraph: roundedGraph, graphInFrame: graphInFrame,
    frameAround: frameAround, interiorOf: interiorOf,
  };
});
