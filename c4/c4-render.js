(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-core.js'), root, require('./c4-place.js'), require('./c4-route.js'),
      require('./c4-markup.js'), require('./c4-card.js'));
  } else {
    var parts = root.ArchUMLC4RenderParts || {};
    root.ArchUMLC4Render = factory(root.ArchUMLC4, root, null, null, parts.markup, parts.card);
  }
})(typeof self !== 'undefined' ? self : this, function (core, root, placeModule, routeModule, markup, card) {
  'use strict';

  // Drawing of C4-notation views (spec §6.1, §6.2, §6.5). The renderer writes presentation attributes only (no
  // `style`, no class-dependent colour), so a live, static, exported, printed, or dark-mode render bakes the same
  // colours. Measuring text needs a canvas, so `renderView` and `render` run in a browser; the palette and its
  // contrast report are pure and load in Node. Interface cards are HTML, drawn by c4-card.js; both write their
  // markup with c4-markup.js.

  // Drawing constants. The gaps between levels, the boundary padding, and the label clearances are the placement
  // engine's (`placementCfg`), so the seed and the boundary labels measure exactly as placement does.
  var CFG = {
    fontSize: 20,
    lineHeight: 26,
    boxWidth: 300,
    boxPad: 12,
    sectionGap: 8,
    svgPad: 24,
    titleGap: 24,
    legendGap: 36,
    legendRow: 48,
    sampleWidth: 56,
    sampleHeight: 40,
    sampleGap: 14,
    labelPad: 4,
    arrowSize: 12,
    strokeWidth: 2,
  };

  var FONT_FAMILY = "'Segoe UI', system-ui, -apple-system, sans-serif";

  // ---- Palette (spec §6.2) --------------------------------------------------------------------

  /**
   * Light ArchUML-style tints with dark text. `<role>Fill`/`<role>Stroke` colour the boxes of each element role,
   * `labelFill` the backgrounds of relationship labels, `boundaryStroke` the dashed boundaries, `edge` the
   * relationship lines and arrowheads.
   */
  var PALETTE = Object.freeze({
    text: '#1f2328',
    labelFill: '#ffffff',
    personFill: '#d3e3f7',
    personStroke: '#2c5289',
    systemFill: '#dde9f8',
    systemStroke: '#335a92',
    containerFill: '#e7f0fb',
    containerStroke: '#3a6299',
    componentFill: '#f1f6fd',
    componentStroke: '#3f679f',
    externalFill: '#eceef1',
    externalStroke: '#59616b',
    boundaryStroke: '#4b5563',
    edge: '#3c4450',
  });

  var TEXT_MINIMUM = 4.5;
  var MARK_MINIMUM = 3;

  // Each backdrop: the page colour behind transparent SVG areas and the transform the page applies to the SVG.
  // The dark page draws the SVG through the site's `filter: invert(1) hue-rotate(180deg)`.
  var BACKDROPS = [
    { name: 'light page', page: '#fdfdfd', transform: identity },
    { name: 'dark page', page: '#121212', transform: invertThenHueRotate180 },
    { name: 'paper', page: '#ffffff', transform: identity },
  ];

  function identity(rgb) {
    return rgb;
  }

  // Filter Effects 1, `hue-rotate` matrix at 180° (cos = -1, sin = 0), applied in sRGB as browsers apply the
  // CSS filter functions, after `invert(1)`; each channel is clamped to [0, 1].
  var HUE_ROTATE_180 = [
    [-0.574, 1.430, 0.144],
    [0.426, 0.430, 0.144],
    [0.426, 1.430, -0.856],
  ];

  function invertThenHueRotate180(rgb) {
    var inverted = rgb.map(function (channel) { return 1 - channel; });
    return HUE_ROTATE_180.map(function (row) {
      var value = row[0] * inverted[0] + row[1] * inverted[1] + row[2] * inverted[2];
      return Math.min(1, Math.max(0, value));
    });
  }

  function hexToRgb(hex) {
    var digits = hex.replace('#', '');
    if (digits.length === 3) digits = digits.split('').map(function (digit) { return digit + digit; }).join('');
    return [0, 2, 4].map(function (start) { return parseInt(digits.slice(start, start + 2), 16) / 255; });
  }

  function relativeLuminance(rgb) {
    var linear = rgb.map(function (channel) {
      return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  function contrastRatio(first, second) {
    var a = relativeLuminance(first);
    var b = relativeLuminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function keysEndingWith(palette, suffix) {
    return Object.keys(palette).filter(function (key) { return key.slice(-suffix.length) === suffix; });
  }

  /** The colour pairs the diagram draws: `[foreground key, background key or 'page', required ratio]`. */
  function drawnPairs(palette) {
    var pairs = [['text', 'page', TEXT_MINIMUM]];
    keysEndingWith(palette, 'Fill').forEach(function (fill) { pairs.push(['text', fill, TEXT_MINIMUM]); });
    keysEndingWith(palette, 'Stroke').concat('edge').forEach(function (mark) { pairs.push([mark, 'page', MARK_MINIMUM]); });
    keysEndingWith(palette, 'Stroke').forEach(function (stroke) {
      var fill = stroke.replace(/Stroke$/, 'Fill');
      if (palette[fill]) pairs.push([stroke, fill, MARK_MINIMUM]);
    });
    return pairs;
  }

  /**
   * The contrast of every drawn colour pair on every backdrop (spec §6.2): `[{pair, backdrop, ratio, required,
   * pass}]`. Palette colours are opaque, so a fill hides the page; the page shows behind text and marks drawn
   * outside boxes.
   */
  function contrastReport(palette) {
    var report = [];
    drawnPairs(palette).forEach(function (pair) {
      BACKDROPS.forEach(function (backdrop) {
        var foreground = backdrop.transform(hexToRgb(palette[pair[0]]));
        var background = pair[1] === 'page' ? hexToRgb(backdrop.page) : backdrop.transform(hexToRgb(palette[pair[1]]));
        var ratio = contrastRatio(foreground, background);
        report.push({ pair: pair[0] + ' on ' + pair[1], backdrop: backdrop.name, ratio: ratio, required: pair[2], pass: ratio >= pair[2] });
      });
    });
    return report;
  }

  // ---- SVG primitives (markup from c4-markup.js) ----------------------------------------------

  var escapeSvgText = markup.escapeSvgText;
  var round = markup.round;
  var element = markup.element;

  /**
   * One line of text. A line of a box or a relationship label carries the part it shows (`line.part`: `data-c4-text`,
   * with `data-c4-index` for a responsibility), which the editor reads to edit that part in place (ED-12).
   */
  function textLine(line, x, y, palette, anchor) {
    return element('text', {
      x: x, y: y, 'font-size': CFG.fontSize, 'font-weight': line.bold ? 'bold' : null,
      'font-style': line.italic ? 'italic' : null, 'text-anchor': anchor || null, fill: palette.text,
      'data-c4-text': line.part || null, 'data-c4-index': line.index === undefined ? null : line.index,
    }, escapeSvgText(line.text));
  }

  /** `lines` (wrapped) marked as showing `part` (`{ part, index }`, or a part name). */
  function showing(lines, part) {
    var marks = typeof part === 'string' ? { part: part } : part;
    return lines.map(function (line) { return Object.assign(line, marks); });
  }

  // ---- Text measurement and wrapping ----------------------------------------------------------

  /** A width measure for `{text, bold, italic}` lines at the C4 font size, backed by the bundle's canvas metrics. */
  function canvasMeasure() {
    var shared = root.UMLShared;
    return function (text, style) {
      return shared.textMetrics(text, style.bold, CFG.fontSize, FONT_FAMILY, style.italic).width;
    };
  }

  /** Word-wraps `text` to `width`; a word longer than the width breaks between characters. */
  function wrap(text, width, style, measure) {
    var lines = [];
    var line = '';
    String(text).split(/\s+/).filter(Boolean).forEach(function (word) {
      var candidate = line ? line + ' ' + word : word;
      if (measure(candidate, style) <= width) {
        line = candidate;
        return;
      }
      if (line) lines.push(line);
      line = '';
      Array.from(word).forEach(function (character) {
        if (line && measure(line + character, style) > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      });
    });
    if (line) lines.push(line);
    return lines.map(function (wrapped) { return { text: wrapped, bold: style.bold, italic: style.italic }; });
  }

  // ---- Shapes (spec §6.1) ---------------------------------------------------------------------

  // Each shape draws its outline into a `width` × `height` box and says how far text keeps from its edges. The
  // first drawn element carries the fill, so it is the box's main outline.

  function roundedBox(width, height, colours, radius) {
    return element('rect', { width: width, height: height, rx: radius, fill: colours.fill, stroke: colours.stroke, 'stroke-width': CFG.strokeWidth });
  }

  function personHeadRadius(height) {
    return Math.min(24, height / 5);
  }

  function cylinderRy(height) {
    return Math.min(14, height / 6);
  }

  function pipeRx(width) {
    return Math.min(18, width / 8);
  }

  function browserBar(height) {
    return Math.min(26, height / 4);
  }

  function folderTab(height) {
    return Math.min(14, height / 5);
  }

  var SHAPES = {
    box: {
      insets: function () { return { top: 14, bottom: 14, side: CFG.boxPad }; },
      draw: function (width, height, colours) { return roundedBox(width, height, colours, 10); },
    },
    person: {
      insets: function (height) { return { top: personHeadRadius(height) * 2 + 12, bottom: 14, side: CFG.boxPad }; },
      draw: function (width, height, colours) {
        var radius = personHeadRadius(height);
        var bodyTop = radius * 2 - radius / 3;
        return element('rect', { y: bodyTop, width: width, height: height - bodyTop, rx: radius, fill: colours.fill, stroke: colours.stroke, 'stroke-width': CFG.strokeWidth }) +
          element('circle', { cx: width / 2, cy: radius, r: radius, fill: colours.fill, stroke: colours.stroke, 'stroke-width': CFG.strokeWidth });
      },
    },
    database: {
      insets: function (height) { return { top: cylinderRy(height) * 2 + 10, bottom: cylinderRy(height) + 10, side: CFG.boxPad }; },
      draw: function (width, height, colours) {
        var ry = cylinderRy(height);
        var rx = width / 2;
        return element('path', {
          d: 'M0 ' + ry + ' A' + rx + ' ' + ry + ' 0 0 1 ' + width + ' ' + ry + ' V' + round(height - ry) +
            ' A' + rx + ' ' + ry + ' 0 0 1 0 ' + round(height - ry) + ' Z',
          fill: colours.fill, stroke: colours.stroke, 'stroke-width': CFG.strokeWidth,
        }) + element('path', {
          d: 'M0 ' + ry + ' A' + rx + ' ' + ry + ' 0 0 0 ' + width + ' ' + ry,
          fill: 'none', stroke: colours.stroke, 'stroke-width': CFG.strokeWidth,
        });
      },
    },
    pipe: {
      insets: function () { return { top: 14, bottom: 14, side: pipeRx(CFG.boxWidth) * 2 + 6 }; },
      draw: function (width, height, colours) {
        var rx = pipeRx(width);
        var ry = height / 2;
        return element('path', {
          d: 'M' + rx + ' 0 H' + (width - rx) + ' A' + rx + ' ' + ry + ' 0 0 1 ' + (width - rx) + ' ' + height +
            ' H' + rx + ' A' + rx + ' ' + ry + ' 0 0 1 ' + rx + ' 0 Z',
          fill: colours.fill, stroke: colours.stroke, 'stroke-width': CFG.strokeWidth,
        }) + element('path', {
          d: 'M' + (width - rx) + ' 0 A' + rx + ' ' + ry + ' 0 0 0 ' + (width - rx) + ' ' + height,
          fill: 'none', stroke: colours.stroke, 'stroke-width': CFG.strokeWidth,
        });
      },
    },
    browser: {
      insets: function (height) { return { top: browserBar(height) + 12, bottom: 14, side: CFG.boxPad }; },
      draw: function (width, height, colours) {
        var bar = browserBar(height);
        var dot = Math.min(4, bar / 6);
        var dots = [1, 2, 3].map(function (index) {
          return element('circle', { cx: index * dot * 3.5, cy: bar / 2, r: dot, fill: colours.stroke, stroke: colours.stroke, 'stroke-width': 1 });
        }).join('');
        return roundedBox(width, height, colours, 10) +
          element('path', { d: 'M0 ' + round(bar) + ' H' + width, fill: 'none', stroke: colours.stroke, 'stroke-width': CFG.strokeWidth }) + dots;
      },
    },
    phone: {
      insets: function () { return { top: 30, bottom: 18, side: CFG.boxPad }; },
      draw: function (width, height, colours) {
        var slotWidth = Math.min(40, width / 3);
        var slotY = Math.min(12, height / 6);
        return roundedBox(width, height, colours, Math.min(22, width / 8)) +
          element('rect', { x: (width - slotWidth) / 2, y: slotY, width: slotWidth, height: Math.min(6, height / 10), rx: 3, fill: colours.stroke, stroke: colours.stroke, 'stroke-width': 1 });
      },
    },
    folder: {
      insets: function (height) { return { top: folderTab(height) + 12, bottom: 14, side: CFG.boxPad }; },
      draw: function (width, height, colours) {
        var tab = folderTab(height);
        var tabWidth = Math.min(90, width * 0.35);
        return element('path', {
          d: 'M0 0 H' + round(tabWidth) + ' L' + round(tabWidth + tab) + ' ' + round(tab) + ' H' + width + ' V' + height + ' H0 Z',
          fill: colours.fill, stroke: colours.stroke, 'stroke-width': CFG.strokeWidth, 'stroke-linejoin': 'round',
        });
      },
    },
  };

  var SHAPE_OF_KIND = {
    database: 'database', queue: 'pipe', topic: 'pipe', browser_app: 'browser', mobile_app: 'phone', file_store: 'folder',
  };

  function shapeOf(node) {
    return SHAPES[node.type === 'person' ? 'person' : (SHAPE_OF_KIND[node.kind] || 'box')];
  }

  /** The box colours of a role: external elements are grey whatever their type (spec §6.2). */
  function roleColours(role, palette) {
    return { fill: palette[role + 'Fill'], stroke: palette[role + 'Stroke'] };
  }

  function nodeColours(node, palette) {
    return roleColours(node.external ? 'external' : node.type, palette);
  }

  // ---- Box text (spec §6.1) -------------------------------------------------------------------

  var BOX_INTERFACE_NAMES = 2;

  /** An interface's name with its mark: where it is offered through, or where it is delegated from. */
  function markedInterfaceName(entry) {
    if (entry.delegatedFromName) return entry.name + ' (delegated from ' + entry.delegatedFromName + ')';
    return entry.declaredOnName ? entry.name + ' (offered through ' + entry.declaredOnName + ')' : entry.name;
  }

  /** "Provides: A, B, +N more": the first two provided interfaces with their marks, then how many are left out. */
  function providesLine(interfaces) {
    var shown = interfaces.slice(0, BOX_INTERFACE_NAMES).map(markedInterfaceName);
    var hidden = interfaces.length - shown.length;
    return 'Provides: ' + shown.concat(hidden > 0 ? ['+' + hidden + ' more'] : []).join(', ');
  }

  /**
   * Name (bold), the bracketed type line (italic), the description lines, one line per annotation, then the
   * provided interfaces (`node.interfaces`, filled only in a view annotated with interfaces).
   */
  function boxText(node, width, measure) {
    var heading = showing(wrap(node.name, width, { bold: true }, measure), 'name')
      .concat(showing(wrap('[' + node.typeLabel + ']', width, { italic: true }, measure), 'type'));
    var body = [];
    var lineParts = node.lineParts || [];
    node.lines.forEach(function (line, index) {
      body = body.concat(showing(wrap(line, width, {}, measure), lineParts[index] || 'line'));
    });
    node.annotations.forEach(function (line) {
      body = body.concat(showing(wrap(line, width, {}, measure), 'annotation'));
    });
    if (node.interfaces.length) body = body.concat(showing(wrap(providesLine(node.interfaces), width, {}, measure), 'interfaces'));
    return { heading: heading, body: body };
  }

  function measureNode(node, measure) {
    var shape = shapeOf(node);
    var side = shape.insets(0).side;
    var text = boxText(node, CFG.boxWidth - 2 * side, measure);
    var lineCount = text.heading.length + text.body.length;
    var textHeight = lineCount * CFG.lineHeight + (text.body.length ? CFG.sectionGap : 0);
    // Insets depend on the height for proportional decorations; two passes settle them.
    var height = textHeight + 60;
    for (var pass = 0; pass < 2; pass++) {
      var insets = shape.insets(height);
      height = insets.top + textHeight + insets.bottom;
    }
    return { shape: shape, text: text, width: CFG.boxWidth, height: Math.ceil(height) };
  }

  function drawNode(node, size, place, palette) {
    var shape = size.shape;
    var insets = shape.insets(size.height);
    var centre = size.width / 2;
    var y = insets.top + CFG.fontSize;
    var lines = [];
    size.text.heading.forEach(function (line) {
      lines.push(textLine(line, centre, y, palette, 'middle'));
      y += CFG.lineHeight;
    });
    y += CFG.sectionGap;
    size.text.body.forEach(function (line) {
      lines.push(textLine(line, centre, y, palette, 'middle'));
      y += CFG.lineHeight;
    });
    return element('g', {
      'data-layout-id': node.id, 'data-c4-type': node.type, 'data-c4-kind': node.kind, 'data-c4-drill': node.drill,
      transform: 'translate(' + round(place.x) + ',' + round(place.y) + ')',
    }, shape.draw(size.width, size.height, nodeColours(node, palette)) + lines.join(''));
  }

  // ---- Boundaries and relationships -----------------------------------------------------------

  var BOUNDARY_DASH = { scope: '10 6', group: '4 5', enterprise: '16 5 3 5' };
  var EDGE_DASH = { async: '9 6', unassigned: '2 6' };

  function boundaryDash(kind) {
    return BOUNDARY_DASH[kind] || BOUNDARY_DASH.scope;
  }

  function boundaryLabel(boundary) {
    return { text: boundary.label + ' [' + boundary.typeLabel + ']', bold: false, italic: false };
  }

  /** A boundary's outline with its label in `labelBox` (the label's place from `placeBoundaryLabels`). */
  function drawBoundary(boundary, box, labelBox, palette) {
    return element('g', { 'data-c4-boundary': boundary.id, 'data-c4-boundary-kind': boundary.kind },
      element('rect', {
        x: box.x, y: box.y, width: box.width, height: box.height, rx: 6, fill: 'none',
        stroke: palette.boundaryStroke, 'stroke-width': CFG.strokeWidth, 'stroke-dasharray': boundaryDash(boundary.kind),
      }) + textLine(boundaryLabel(boundary), labelBox.x, labelBox.y + CFG.fontSize, palette));
  }

  function edgeDash(edge) {
    if (edge.unassigned) return EDGE_DASH.unassigned;
    return edge.async ? EDGE_DASH.async : null;
  }

  /** "via Enrollment API": the first interface the edge uses, then how many more, as "(+N more)". */
  function viaLine(interfaces) {
    var more = interfaces.length - 1;
    return 'via ' + interfaces[0].name + (more > 0 ? ' (+' + more + ' more)' : '');
  }

  /**
   * An edge label's texts: the description, the bracketed technology, and, in a view annotated with interfaces, the
   * interface the edge uses.
   */
  function edgeLabelTexts(edge, annotations) {
    var texts = [];
    if (edge.description) texts.push({ part: 'description', text: edge.description + (edge.moreCount ? ' (+' + edge.moreCount + ' more)' : '') });
    if (edge.technology) texts.push({ part: 'technology', text: '[' + edge.technology + ']' });
    if (annotations.indexOf('interfaces') >= 0 && edge.interfaces.length) texts.push({ part: 'interfaces', text: viaLine(edge.interfaces) });
    return texts;
  }

  /** The label texts of an edge, each wrapped at the box width (spec §6.1) and marked with the part it shows. */
  function edgeLabelLines(edge, annotations, measure) {
    return edgeLabelTexts(edge, annotations).reduce(function (lines, entry) {
      return lines.concat(showing(wrap(entry.text, CFG.boxWidth, {}, measure), entry.part));
    }, []);
  }

  function arrowHead(tip, from, colour) {
    var dx = tip.x - from.x;
    var dy = tip.y - from.y;
    var length = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / length;
    var uy = dy / length;
    var back = { x: tip.x - ux * CFG.arrowSize, y: tip.y - uy * CFG.arrowSize };
    var half = CFG.arrowSize * 0.45;
    var points = [tip, { x: back.x - uy * half, y: back.y + ux * half }, { x: back.x + uy * half, y: back.y - ux * half }];
    return element('polygon', {
      points: points.map(function (point) { return round(point.x) + ',' + round(point.y); }).join(' '),
      fill: colour, stroke: colour, 'stroke-width': 1,
    });
  }

  function drawEdgeLabel(lines, box, palette) {
    if (!box) return '';
    var centre = box.x + box.width / 2;
    // The hook lets a page give the backdrop its own colour on screen (a dark page draws the drawing through an invert
    // filter); the fill stays baked, so the exported drawing needs no stylesheet.
    return element('rect', { 'data-c4-label-backdrop': 'true', x: box.x, y: box.y, width: box.width, height: box.height, fill: palette.labelFill, stroke: palette.labelFill, 'stroke-width': 1 }) +
      lines.map(function (line, index) {
        return textLine(line, centre, box.y + CFG.labelPad + CFG.fontSize + index * CFG.lineHeight, palette, 'middle');
      }).join('');
  }

  function drawEdge(edge, route, labelLines, palette) {
    var points = route.points;
    var last = points[points.length - 1];
    var path = 'M' + points.map(function (point) { return round(point.x) + ' ' + round(point.y); }).join(' L');
    return element('g', {
      'data-layout-route-id': edge.id, 'data-c4-source': edge.sourceId, 'data-c4-target': edge.targetId,
      'data-c4-derived': String(edge.derived),
    }, element('path', { d: path, fill: 'none', stroke: palette.edge, 'stroke-width': CFG.strokeWidth, 'stroke-dasharray': edgeDash(edge) }) +
      arrowHead(last, points[points.length - 2], palette.edge) +
      drawEdgeLabel(labelLines, route.labelBox, palette));
  }

  // ---- Layout (spec §6.4) ---------------------------------------------------------------------

  // Boxes are `{x, y, width, height}` in diagram units. The layout never reads the container, so a static prerender
  // and a live render of the same view agree.

  var TOP_ANCHOR = '\u0000top';
  var BOTTOM_ANCHOR = '\u0000bottom';

  /** What every layout step reads about one view: sizes, nesting, and the edges' label lines. */
  function layoutContext(viewModel, measure) {
    var parentOf = {};
    var sizes = {};
    viewModel.nodes.forEach(function (node) {
      parentOf[node.id] = node.boundaryId || null;
      sizes[node.id] = measureNode(node, measure);
    });
    viewModel.boundaries.forEach(function (boundary) {
      parentOf[boundary.id] = boundary.parentBoundaryId || null;
    });
    return {
      viewModel: viewModel, measure: measure, parentOf: parentOf, sizes: sizes,
      labelLines: viewModel.edges.map(function (edge) { return edgeLabelLines(edge, viewModel.annotations, measure); }),
    };
  }

  function labelSize(lines, measure) {
    if (!lines.length) return { width: 0, height: 0 };
    var widest = Math.max.apply(null, lines.map(function (line) { return measure(line.text, line); }));
    return { width: widest + 2 * CFG.labelPad, height: lines.length * CFG.lineHeight + 2 * CFG.labelPad };
  }

  var GRAPH_BOUNDARY_KIND = { scope: 'scope', group: 'group', enterprise: 'enterprise', system: 'element' };

  /**
   * The view as the placement engine reads it (routing redesign §3.2): sized items, boundaries with their label
   * sizes, and edges with their label sizes, all in view-model order.
   */
  function placementGraph(context) {
    var viewModel = context.viewModel;
    return {
      items: viewModel.nodes.map(function (node) {
        return {
          id: node.id, width: context.sizes[node.id].width, height: context.sizes[node.id].height,
          parent: node.boundaryId || null, role: node.type === 'person' ? 'person' : 'element', external: Boolean(node.external),
        };
      }),
      boundaries: viewModel.boundaries.map(function (boundary) {
        return {
          id: boundary.id, parent: boundary.parentBoundaryId || null, kind: GRAPH_BOUNDARY_KIND[boundary.kind] || 'element',
          labelWidth: context.measure(boundaryLabel(boundary).text, {}), labelHeight: CFG.lineHeight,
        };
      }),
      edges: viewModel.edges.map(function (edge, index) {
        var size = labelSize(context.labelLines[index], context.measure);
        return { id: edge.id, source: edge.sourceId, target: edge.targetId, labelWidth: size.width, labelHeight: size.height, derived: Boolean(edge.derived) };
      }),
      scopeId: viewModel.scopeId || null,
    };
  }

  // ---- Seed (spec §6.4 steps 1–3; routing redesign §4.2) --------------------------------------

  /** A placement graph's nesting: each id's parent boundary, its item or boundary, and every id in graph order. */
  function nestingOf(graph) {
    var nesting = { graph: graph, parentOf: {}, items: {}, boundaries: {}, order: [] };
    graph.items.forEach(function (item) {
      nesting.parentOf[item.id] = item.parent || null;
      nesting.items[item.id] = item;
      nesting.order.push(item.id);
    });
    graph.boundaries.forEach(function (boundary) {
      nesting.parentOf[boundary.id] = boundary.parent || null;
      nesting.boundaries[boundary.id] = boundary;
      nesting.order.push(boundary.id);
    });
    return nesting;
  }

  /** Items first, then boundaries, each in graph order: the ids directly inside `levelId` (null: the outer level). */
  function childrenOf(nesting, levelId) {
    return nesting.order.filter(function (id) { return nesting.parentOf[id] === levelId; });
  }

  /** The child of `levelId` that is `id` or contains it; null when `id` lies outside the level or is the level itself. */
  function itemAt(nesting, id, levelId) {
    for (var current = id; current !== null && current !== undefined; current = nesting.parentOf[current]) {
      if (nesting.parentOf[current] === levelId) return current;
    }
    return null;
  }

  function isPerson(nesting, id) {
    return Boolean(nesting.items[id]) && nesting.items[id].role === 'person';
  }

  /**
   * The ranking edges of one level, `source` above `target`. Elements connected to outside people or called from
   * outside hang from a virtual top anchor; elements that depend on outside elements hang above a virtual bottom one.
   * Around the item holding the view's scope, people and callers go above it and everything else below (step 3).
   */
  function levelEdges(nesting, levelId) {
    var graph = nesting.graph;
    var pivot = graph.scopeId ? itemAt(nesting, graph.scopeId, levelId) : null;
    var edges = [];
    graph.edges.forEach(function (edge) {
      var source = itemAt(nesting, edge.source, levelId);
      var target = itemAt(nesting, edge.target, levelId);
      var size = { width: edge.labelWidth, height: edge.labelHeight };
      if (source && target && source !== target) edges.push(rankedAroundPivot(nesting, source, target, pivot, size));
      else if (source && !target && levelId !== null) {
        edges.push(isPerson(nesting, edge.target) ? anchorEdge(TOP_ANCHOR, source) : anchorEdge(source, BOTTOM_ANCHOR));
      } else if (target && !source && levelId !== null) edges.push(anchorEdge(TOP_ANCHOR, target));
    });
    return edges.filter(function (edge) { return edge.source !== edge.target; });
  }

  function anchorEdge(source, target) {
    return { source: source, target: target, size: { width: 0, height: 0 } };
  }

  function rankedAroundPivot(nesting, source, target, pivot, size) {
    var other = source === pivot ? target : (target === pivot ? source : null);
    if (other === null) return { source: source, target: target, size: size };
    var above = isPerson(nesting, other) || (other === source && !callsFromPivot(nesting, pivot, other));
    return above ? { source: other, target: pivot, size: size } : { source: pivot, target: other, size: size };
  }

  /** Whether any relationship runs from inside (or at) the pivot item to `other`. */
  function callsFromPivot(nesting, pivot, other) {
    var levelId = nesting.parentOf[pivot];
    return nesting.graph.edges.some(function (edge) {
      return itemAt(nesting, edge.source, levelId) === pivot && itemAt(nesting, edge.target, levelId) === other;
    });
  }

  /** One ranking edge per ordered pair, sized by its largest label. */
  function mergedEdges(edges) {
    var byPair = {};
    var merged = [];
    edges.forEach(function (edge) {
      var key = edge.source + '\u0000' + edge.target;
      if (!byPair[key]) {
        byPair[key] = { source: edge.source, target: edge.target, size: { width: 0, height: 0 } };
        merged.push(byPair[key]);
      }
      byPair[key].size = {
        width: Math.max(byPair[key].size.width, edge.size.width), height: Math.max(byPair[key].size.height, edge.size.height),
      };
    });
    return merged;
  }

  /**
   * The top anchor also reaches every item nothing in the level points to, so it sits above all of them and never
   * pushes a pulled item below an unpulled one.
   */
  function topAnchorRowEdges(items, edges) {
    if (!edges.some(function (edge) { return edge.source === TOP_ANCHOR; })) return [];
    return items.filter(function (item) {
      return !edges.some(function (edge) { return edge.target === item.id; });
    }).map(function (item) { return anchorEdge(TOP_ANCHOR, item.id); });
  }

  /** Places `items` (`{id, width, height}`) with the shared layered layout; returns their boxes from (0, 0). */
  function placeItems(items, edges) {
    var spacing = placementCfg();
    var anchors = [TOP_ANCHOR, BOTTOM_ANCHOR].filter(function (anchor) {
      return edges.some(function (edge) { return edge.source === anchor || edge.target === anchor; });
    });
    // An anchor is as wide as a box, so the layout spaces the elements around it as it spaces elements.
    var layoutNodes = items.map(function (item) { return { id: item.id, width: item.width, height: item.height }; })
      .concat(anchors.map(function (anchor) { return { id: anchor, width: CFG.boxWidth, height: 1 }; }));
    edges = edges.concat(topAnchorRowEdges(items, edges));
    var result = root.UMLAdvancedLayout.compute(layoutNodes, edges.map(function (edge) {
      return { source: edge.source, target: edge.target, type: 'dependency' };
    }), {
      gapX: spacing.levelGapX, gapY: spacing.levelGapY, direction: 'TB', labelFontSize: CFG.fontSize,
      edgeSizes: edges.map(function (edge) {
        return { source: edge.source, target: edge.target, labelWidth: edge.size.width, labelHeight: edge.size.height, markerExtent: CFG.arrowSize, padding: spacing.levelGapY / 2 };
      }),
    });
    var boxes = items.map(function (item) {
      var at = result.nodes[item.id];
      if (!at) throw new Error('The shared layout placed no box for ' + item.id + ': ' + root.__UMLLayoutLastError);
      return { id: item.id, x: at.x, y: at.y, width: item.width, height: item.height };
    });
    var bounds = boundsOf(boxes);
    boxes.forEach(function (box) {
      box.x -= bounds.x;
      box.y -= bounds.y;
    });
    return { boxes: boxes, width: bounds.width, height: bounds.height };
  }

  function boundsOf(boxes) {
    if (!boxes.length) return { x: 0, y: 0, width: 0, height: 0 };
    var left = Math.min.apply(null, boxes.map(function (box) { return box.x; }));
    var top = Math.min.apply(null, boxes.map(function (box) { return box.y; }));
    var right = Math.max.apply(null, boxes.map(function (box) { return box.x + box.width; }));
    var bottom = Math.max.apply(null, boxes.map(function (box) { return box.y + box.height; }));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /**
   * Steps 1–3: each level laid out inside out; returns the level's items with positions relative to its origin. A
   * boundary is framed around its inner level by the placement engine's `frameAround`, as placement's settle step
   * frames it.
   */
  function arrangeLevel(nesting, levelId) {
    var items = childrenOf(nesting, levelId).map(function (id) {
      var item = nesting.items[id];
      if (item) return { id: id, width: item.width, height: item.height, inner: null };
      var inner = arrangeLevel(nesting, id);
      var frame = placement().frameAround(nesting.boundaries[id], inner.boxes);
      return { id: id, width: frame.width, height: frame.height, inner: inner, innerOrigin: { x: -frame.x, y: -frame.y } };
    });
    var placed = placeItems(items, mergedEdges(levelEdges(nesting, levelId)));
    placed.boxes.forEach(function (box, index) {
      box.inner = items[index].inner;
      box.innerOrigin = items[index].innerOrigin;
    });
    return placed;
  }

  /** Puts every box of `level` at its offset from the origin; a boundary's inner level starts where its frame puts it. */
  function assignPositions(level, originX, originY, layout) {
    level.boxes.forEach(function (item) {
      var box = { x: originX + item.x, y: originY + item.y, width: item.width, height: item.height };
      if (!item.inner) {
        layout.nodes[item.id] = box;
        return;
      }
      layout.boundaries[item.id] = box;
      assignPositions(item.inner, box.x + item.innerOrigin.x, box.y + item.innerOrigin.y, layout);
    });
  }

  /**
   * The seed of the placement engine (routing redesign §4.2; spec §6.4 steps 1–3): the top-left corner `{x, y}` of
   * every item of a placement graph, from the shared layered layout run per boundary, top to bottom. Needs
   * `UMLAdvancedLayout` and, for boundaries, the placement engine (`ArchUMLC4Place`).
   */
  function seedPositions(graph) {
    var layout = { nodes: {}, boundaries: {} };
    assignPositions(arrangeLevel(nestingOf(graph), null), 0, 0, layout);
    var seed = {};
    graph.items.forEach(function (item) { seed[item.id] = { x: layout.nodes[item.id].x, y: layout.nodes[item.id].y }; });
    return seed;
  }

  /** The placement engine (`ArchUMLC4Place`), resolved when a view is laid out, never when this script loads. */
  function placement() {
    return placeModule || root.ArchUMLC4Place;
  }

  /** The routing engine (`ArchUMLC4Route`), resolved when a view is laid out, never when this script loads. */
  function router() {
    return routeModule || root.ArchUMLC4Route;
  }

  /** The placement engine's constants (`ArchUMLC4Place.CFG`), the one source of the gaps, padding and clearances. */
  function placementCfg() {
    return placement().CFG;
  }

  // ---- Route geometry -----------------------------------------------------------------------

  function segmentsOf(points) {
    return points.slice(1).map(function (point, index) { return { from: points[index], to: point }; });
  }

  function segmentRect(segment) {
    return {
      x: Math.min(segment.from.x, segment.to.x), y: Math.min(segment.from.y, segment.to.y),
      width: Math.abs(segment.to.x - segment.from.x), height: Math.abs(segment.to.y - segment.from.y),
    };
  }

  // ---- Boundary labels (routing redesign §4.1, Ruling 16) ---------------------------------------------------------

  /**
   * Where each boundary's label goes, in view-model order (`{x, y, width, height, labelFallback}`). Placement keeps
   * no room for a label where edges leave a boundary, so the label moves instead: to the start of the widest span
   * of its label line, below the members, that no route and no edge label crosses; when that line has no span wide
   * enough, to the start of the widest such span of the line in the boundary's top padding. When neither line has
   * room, the label sits at the top-left corner inside the boundary and is marked `labelFallback`: a route or an
   * edge label then reaches it.
   */
  function placeBoundaryLabels(context, layout, routes, edgeLabels) {
    var segments = routes.reduce(function (all, points) { return all.concat(segmentsOf(points).map(segmentRect)); }, []);
    var pad = placementCfg().boundaryPad;
    return context.viewModel.boundaries.map(function (boundary) {
      var box = layout.boundaries[boundary.id];
      var label = boundaryLabel(boundary);
      var width = context.measure(label.text, label);
      var line = [box.x + pad / 2, box.x + box.width - pad / 2];
      var labelLine = box.y + box.height - pad / 2 - CFG.fontSize;
      var topLine = box.y + (pad - CFG.lineHeight) / 2;
      var rows = [labelLine, topLine].map(function (y) { return { x: line[0], y: y, width: width, height: CFG.lineHeight }; });
      for (var index = 0; index < rows.length; index++) {
        var span = widestClearSpan(line, routeCrossings(rows[index], segments).concat(labelCrossings(rows[index], edgeLabels)));
        if (span[1] - span[0] >= width) return Object.assign(rows[index], { x: Math.ceil(span[0]), labelFallback: false });
      }
      return Object.assign(rows[1], { labelFallback: true });
    });
  }

  /** The x ranges, widened by the foreign-route clearance, where route segments pass through `label`'s row. */
  function routeCrossings(label, segments) {
    var clear = placementCfg().labelForeignClear;
    var top = label.y - clear;
    var bottom = label.y + label.height + clear;
    return segments.filter(function (segment) { return segment.y <= bottom && segment.y + segment.height >= top; })
      .map(function (segment) { return [segment.x - clear, segment.x + segment.width + clear]; });
  }

  /** The x ranges, widened by the label clearance, where edge labels reach into `label`'s row. */
  function labelCrossings(label, edgeLabels) {
    var clear = placementCfg().labelBoxClear;
    return edgeLabels.filter(function (other) {
      return other.y < label.y + label.height + clear && other.y + other.height > label.y - clear;
    }).map(function (other) { return [other.x - clear, other.x + other.width + clear]; });
  }

  /** The widest part of the range `[from, to]` outside every range of `blocked` (the leftmost of equals). */
  function widestClearSpan(range, blocked) {
    var free = [range];
    blocked.forEach(function (cut) {
      free = free.reduce(function (parts, part) {
        if (cut[1] <= part[0] || cut[0] >= part[1]) return parts.concat([part]);
        return parts.concat([[part[0], cut[0]], [cut[1], part[1]]].filter(function (piece) { return piece[1] > piece[0]; }));
      }, []);
    });
    return free.reduce(function (best, part) {
      return part[1] - part[0] > best[1] - best[0] ? part : best;
    }, [range[0], range[0]]);
  }

  /** Whether two placements put every box, boundary and corridor in the same place: what routing reads of them. */
  function samePlacement(a, b) {
    var routed = function (placed) { return JSON.stringify([placed.boxes, placed.boundaries, placed.corridors]); };
    return routed(a) === routed(b);
  }

  /**
   * The placement and the routes of a view (routing redesign §3.1, §6.4): `ArchUMLC4Place.place` from the seed of
   * `seedPositions`, then `ArchUMLC4Route.route`, which routes and labels every edge. While the router asks for
   * growth and rounds remain (`maxGrowthRounds`), each corridor it names grows by what it asks, and the view is
   * placed and routed again; the corridors that placement reports a pin blocks (`pinnedCorridors`) are never
   * grown. Growth that leaves the placement unchanged (a corridor already wider than it needs absorbs it) ends the
   * rounds: routing is deterministic, so the same scene would only be routed to the same answer. Returns
   * `{placed, routed}` of the last round routed. A box that any round's settle step moved aside for a pin keeps
   * `madeRoom` in the result: a later round can give it that place by growing a corridor for a label the move
   * crowded, and then its settle step has nothing to move.
   */
  function placeAndRoute(context, graph, pins) {
    var direction = context.viewModel.direction || 'down';
    var seed = seedPositions(graph);
    var extra = new Map();
    var previous = null;
    var madeRoom = new Set();
    function marked(result) {
      madeRoom.forEach(function (id) { result.placed.boxes[id].madeRoom = true; });
      return result;
    }
    for (var round = 0; ; round++) {
      var placed = placement().place(graph, { direction: direction, seed: seed, pins: pins, corridorExtra: extra.size ? extra : null });
      Object.keys(placed.boxes).forEach(function (id) { if (placed.boxes[id].madeRoom) madeRoom.add(id); });
      if (previous && samePlacement(previous.placed, placed)) return marked(previous);
      // Boundary labels move clear of the routes and labels afterwards (placeBoundaryLabels), so routing sees none.
      var routed = router().route({
        boxes: placed.boxes, boundaries: placed.boundaries, boundaryLabels: [], parentOf: context.parentOf,
        edges: graph.edges, direction: direction, corridors: placed.corridors,
      }, { shared: root.UMLShared, noGrowth: placed.pinnedCorridors });
      previous = { placed: placed, routed: routed };
      if (!routed.growth.length || round === router().CFG.maxGrowthRounds) return marked(previous);
      routed.growth.forEach(function (request) { extra.set(request.corridorId, (extra.get(request.corridorId) || 0) + request.by); });
    }
  }

  /**
   * `{ nodes: {id: {x, y, width, height, pinAdjusted, madeRoom}}, boundaries: {id: box}, edges: [{id, points, labelBox, bends,
   * fallbackRoute, labelFallback}], boundaryLabels: [{id, x, y, width, height, labelFallback}], routeStats, x, y,
   * width, height }`
   * for a C4-notation view (spec §6.4): placed by `ArchUMLC4Place.place` in the view's direction, then routed and
   * labelled by `ArchUMLC4Route.route` (`routeStats` is its `stats`), with corridors grown for labels that need it
   * (`placeAndRoute`). `x, y, width, height` bound everything drawn; `options.pins` is a `Map` from element id to
   * the `[x, y]` of its box's top-left corner.
   */
  function layoutView(viewModel, measure, options) {
    var context = layoutContext(viewModel, measure || canvasMeasure());
    var graph = placementGraph(context);
    var result = placeAndRoute(context, graph, (options && options.pins) || null);
    var routed = result.routed;
    var layout = { nodes: result.placed.boxes, boundaries: result.placed.boundaries };
    var routes = routed.edges.map(function (edge) { return edge.points; });
    var labels = routed.edges.map(function (edge) { return edge.labelBox; }).filter(Boolean);
    var boundaryLabels = placeBoundaryLabels(context, layout, routes, labels);
    layout.edges = routed.edges.map(function (edge) {
      return { id: edge.id, points: edge.points, labelBox: edge.labelBox, bends: edge.bends, fallbackRoute: edge.fallbackRoute, labelFallback: edge.labelFallback };
    });
    layout.routeStats = routed.stats;
    layout.boundaryLabels = viewModel.boundaries.map(function (boundary, index) {
      return Object.assign({ id: boundary.id }, boundaryLabels[index]);
    });
    var drawn = Object.keys(layout.nodes).map(function (id) { return layout.nodes[id]; })
      .concat(Object.keys(layout.boundaries).map(function (id) { return layout.boundaries[id]; }), boundaryLabels,
        labels, routes.reduce(function (all, points) { return all.concat(segmentsOf(points).map(segmentRect)); }, []));
    var bounds = boundsOf(drawn);
    layout.x = bounds.x;
    layout.y = bounds.y;
    layout.width = bounds.width;
    layout.height = bounds.height;
    return layout;
  }

  // ---- Legend and title (spec §6.1) -----------------------------------------------------------

  var LEGEND_SHAPE_KINDS = ['browser_app', 'mobile_app', 'desktop_app', 'function', 'database', 'file_store', 'queue', 'topic'];
  var LEGEND_BOUNDARY_KINDS = { 'boundary-scope': 'scope', group: 'group', enterprise: 'enterprise' };

  function legendSample(key, palette) {
    var width = CFG.sampleWidth;
    var height = CFG.sampleHeight;
    if (LEGEND_BOUNDARY_KINDS[key]) {
      return element('rect', { x: 1, y: 1, width: width - 2, height: height - 2, rx: 4, fill: 'none', stroke: palette.boundaryStroke, 'stroke-width': CFG.strokeWidth, 'stroke-dasharray': boundaryDash(LEGEND_BOUNDARY_KINDS[key]) });
    }
    if (EDGE_DASH[key]) {
      var tip = { x: width, y: height / 2 };
      return element('path', { d: 'M0 ' + height / 2 + ' H' + (width - CFG.arrowSize), fill: 'none', stroke: palette.edge, 'stroke-width': CFG.strokeWidth, 'stroke-dasharray': EDGE_DASH[key] }) +
        arrowHead(tip, { x: 0, y: height / 2 }, palette.edge);
    }
    if (LEGEND_SHAPE_KINDS.indexOf(key) >= 0) return shapeOf({ type: 'container', kind: key }).draw(width, height, roleColours('container', palette));
    return shapeOf({ type: key }).draw(width, height, roleColours(key, palette));
  }

  function legendWidth(legend, measure) {
    return legend.reduce(function (widest, entry) {
      return Math.max(widest, CFG.sampleWidth + CFG.sampleGap + measure(entry.label, {}));
    }, 0);
  }

  function drawLegend(legend, top, palette) {
    return legend.map(function (entry, index) {
      var y = top + index * CFG.legendRow;
      return element('g', { 'data-c4-legend': entry.key },
        element('g', { transform: 'translate(0,' + round(y) + ')' }, legendSample(entry.key, palette)) +
        textLine({ text: entry.label }, CFG.sampleWidth + CFG.sampleGap, y + CFG.sampleHeight / 2 + CFG.fontSize / 3, palette));
    }).join('');
  }

  // ---- View rendering -------------------------------------------------------------------------

  function sizeNodes(viewModel, measure) {
    var sizes = {};
    viewModel.nodes.forEach(function (node) { sizes[node.id] = measureNode(node, measure); });
    return sizes;
  }

  /** The SVG text of a laid-out C4-notation view: title, boundaries, elements, relationships, then the legend. */
  function svgOf(viewModel, layout, palette, measure) {
    var sizes = sizeNodes(viewModel, measure);
    var title = viewModel.title ? { text: viewModel.title, bold: true } : null;
    var diagramTop = title ? CFG.lineHeight + CFG.titleGap : 0;
    var legendTop = diagramTop + layout.height + CFG.legendGap;
    var legendHeight = viewModel.legend.length ? (viewModel.legend.length - 1) * CFG.legendRow + CFG.sampleHeight : 0;
    var contentWidth = Math.max(layout.width, legendWidth(viewModel.legend, measure), title ? measure(title.text, title) : 0);
    var width = Math.ceil(contentWidth + 2 * CFG.svgPad);
    var height = Math.ceil(legendTop + legendHeight + 2 * CFG.svgPad);
    var boundaries = viewModel.boundaries.map(function (boundary, index) {
      return drawBoundary(boundary, layout.boundaries[boundary.id], layout.boundaryLabels[index], palette);
    });
    var nodes = viewModel.nodes.map(function (node) { return drawNode(node, sizes[node.id], layout.nodes[node.id], palette); });
    var edges = viewModel.edges.map(function (edge, index) {
      return drawEdge(edge, layout.edges[index], edgeLabelLines(edge, viewModel.annotations, measure), palette);
    });
    var diagram = element('g', { transform: 'translate(' + round(-layout.x) + ',' + round(diagramTop - layout.y) + ')' }, boundaries.join('') + nodes.join('') + edges.join(''));
    return element('svg', {
      xmlns: 'http://www.w3.org/2000/svg', width: width, height: height, viewBox: '0 0 ' + width + ' ' + height,
      'font-family': FONT_FAMILY,
    }, (title ? element('title', {}, escapeSvgText(title.text)) : '') +
      element('g', { transform: 'translate(' + CFG.svgPad + ',' + CFG.svgPad + ')' },
        (title ? textLine(title, 0, CFG.fontSize, palette) : '') + diagram + drawLegend(viewModel.legend, legendTop, palette)));
  }

  /**
   * Draws a C4-notation ViewModel into `container` and returns `{ svgText }`, the standalone SVG (for export).
   * `options.palette` overrides colours of `PALETTE` by name; `options.pins` maps element ids to the `[x, y]` of
   * their boxes' top-left corners; `options.interactive` is accepted and ignored (the editor milestone defines it).
   * Each node of `viewModel` gets `pinAdjusted`, whether its pin had to give way, and `madeRoom`, whether it moved
   * aside for a pinned box that overlapped it (routing redesign §4.7). The drawing keeps its `<title>`
   * but gets no accessible name: `render` names the figure once, from the embed text (a caller that draws a view
   * model itself labels it the same way).
   */
  function renderView(container, viewModel, options) {
    var shared = root.UMLShared;
    var palette = Object.assign({}, PALETTE, options && options.palette);
    var measure = canvasMeasure();
    var layout = layoutView(viewModel, measure, { pins: options && options.pins });
    viewModel.nodes.forEach(function (node) {
      node.pinAdjusted = layout.nodes[node.id].pinAdjusted;
      node.madeRoom = layout.nodes[node.id].madeRoom;
    });
    var svgText = svgOf(viewModel, layout, palette, measure);
    shared.prepareDiagramContainer(container, 'c4');
    container.classList.add('uml-c4-diagram-container');
    container.innerHTML = svgText;
    shared.autoFitSVG(container);
    return { svgText: svgText };
  }

  // ---- Print orientation (routing redesign §9.3 "Print") -------------------------------------------------------

  // Printed C4 labels are at least 9 pt (instructor decision). A drawing scales to its printed column, so its
  // smallest text reaches 9 pt only in a column at least `width × 12 / smallest font size` CSS px wide (9 pt = 12 px).
  // The narrowest portrait column a C4 figure prints in is a quiz card on A4 with the site's 2 cm margins (550 px).
  var PRINT = Object.freeze({ minimumPx: 12, portraitColumnPx: 550 });

  /** The font size of `text`: its own `font-size` attribute or the nearest ancestor's; null when none sets one. */
  function attributeFontSize(text) {
    var holder = text.closest('[font-size]');
    var size = holder ? parseFloat(holder.getAttribute('font-size')) : NaN;
    return isFinite(size) && size > 0 ? size : null;
  }

  /**
   * The narrowest column (CSS px) in which `svg` prints its smallest text at 9 pt: its user-space width scaled by
   * 12 px over its smallest font size. Null for a drawing without sized text.
   */
  function readablePrintWidth(svg) {
    var sizes = Array.prototype.map.call(svg.querySelectorAll('text'), attributeFontSize).filter(function (size) { return size !== null; });
    var viewBox = svg.viewBox && svg.viewBox.baseVal;
    var width = viewBox && viewBox.width ? viewBox.width : parseFloat(svg.getAttribute('width'));
    if (!sizes.length || !(width > 0)) return null;
    return Math.ceil(width * PRINT.minimumPx / Math.min.apply(null, sizes));
  }

  /**
   * Marks the drawing in `container` with `data-c4-print="landscape"` when a portrait column would print its smallest
   * text below 9 pt; print CSS then gives its figure a landscape page. The mark belongs to the page, not to the
   * exported drawing (`svgText`). `render` marks its own drawings; a caller of `renderView` that prints the drawing
   * (the editor's canvas) marks it with this. A container without a drawing has nothing to mark.
   */
  function markPrintOrientation(container) {
    var svg = container.querySelector('svg');
    if (svg === null) return;
    var width = readablePrintWidth(svg);
    if (width !== null && width > PRINT.portraitColumnPx) svg.setAttribute('data-c4-print', 'landscape');
    else svg.removeAttribute('data-c4-print');
  }

  // ---- Embeds: delegated UML views, states, and the embed's own source (spec §3.3, §6.3, §6.5, §7.3) ----------

  var DELEGATED_RENDERERS = {
    'uml-class': 'UMLClassDiagram',
    'uml-sequence': 'UMLSequenceDiagram',
    'uml-deployment': 'UMLDeploymentDiagram',
    'uml-component': 'UMLComponentDiagram',
  };

  /** The value of a `# name: value` comment line of an embed, or null. */
  function embedDirective(text, name) {
    var pattern = new RegExp('^#\\s*' + name + '\\s*:\\s*(.*?)\\s*$', 'i');
    var lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var match = pattern.exec(lines[i]);
      if (match) return match[1];
    }
    return null;
  }

  function firstErrorLine(design) {
    var error = design.diagnostics.filter(function (diagnostic) { return diagnostic.severity === 'error' && diagnostic.range; })[0];
    return error ? error.range.start.line : 1;
  }

  /** The state an embed shows instead of a figure, as `{ kind, message }`, or null when the embed can be drawn. */
  function embedState(design, viewModel, selector) {
    if (design.model === null) {
      return { kind: 'yaml-error', message: "This diagram's source has a YAML error on line " + firstErrorLine(design) + '.' };
    }
    if (design.model.rootIds.length === 0) {
      return { kind: 'empty-model', message: 'This model has no people or systems yet.' };
    }
    if (viewModel.type === null) {
      var reason = viewModel.diagnostics.map(function (diagnostic) { return diagnostic.message.replace(/\.$/, ''); }).join('; ');
      var valid = core.listViews(design).map(function (view) { return view.selector; }).join(', ');
      return { kind: 'unknown-view', message: 'This diagram cannot show the view “' + selector + '”: ' + reason + '. Valid views: ' + valid + '.' };
    }
    return null;
  }

  function showState(container, state) {
    var shared = root.UMLShared;
    shared.prepareDiagramContainer(container, 'c4');
    container.classList.add('uml-c4-diagram-container');
    var message = document.createElement('div');
    message.className = state.kind === 'empty-model' ? 'uml-empty-msg' : 'uml-error-msg';
    message.textContent = state.message;
    container.replaceChildren(message);
    container.setAttribute('data-c4-state', state.kind);
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label', state.message);
  }

  // The deployment layout sizes the gap between top-level nodes by label height, so a long description between
  // them floats away from its link. A communication path is drawn with its technology alone; the description
  // stays in the text alternative, which `core.describe` builds from the unchanged view model.
  function withTechnologyLabels(viewModel) {
    if (viewModel.notation !== 'uml-deployment') return viewModel;
    var links = viewModel.uml.links.map(function (link) {
      return Object.assign({}, link, { label: link.technology || link.label, technology: null });
    });
    return Object.assign({}, viewModel, { uml: Object.assign({}, viewModel.uml, { links: links }) });
  }

  /** The inner element a delegated drawing goes into (spec §6.3). */
  function delegatedViewElement() {
    var inner = document.createElement('div');
    inner.className = 'c4-uml-view';
    // The C4 figure owns the fit control and the scrolling; the inner view must not add its own inside the image.
    inner.setAttribute('data-uml-fit', 'off');
    return inner;
  }

  /**
   * The parts of a delegated view's figure: `inner`, the element its drawing goes into, and `content`, what the C4
   * container shows. An interfaces view (spec §6.6) shows the view's title above the drawing and, below it, the legend
   * line (or the empty-state text) and the notes. The text is the core description's legend and notes, so the figure
   * and its text alternative say the same; the `c4-figure-body` element holds all of it, and the static prerender
   * takes it whole. Every other view shows its drawing alone.
   */
  function figureParts(viewModel) {
    var inner = delegatedViewElement();
    if (viewModel.notation !== 'uml-component') return { content: inner, inner: inner };
    var description = core.describe(viewModel);
    var body = document.createElement('div');
    body.className = 'c4-figure-body';
    body.append(paragraph('c4-figure-title', viewModel.title), inner);
    describedItems(description, 'Legend').forEach(function (text) { body.append(paragraph('c4-figure-legend', text)); });
    describedItems(description, 'Notes').forEach(function (text) { body.append(paragraph('c4-figure-note', text)); });
    return { content: body, inner: inner };
  }

  // A figure is read, not edited. ArchUML's compact layout draws a class or component diagram narrower in units of
  // its smallest text, so a code or interfaces view fits more panes at paragraph size before it has to scroll
  // (measured on the site's figures in Nov 2026: code views 26–36 % narrower, interfaces views 17–24 %; sequence
  // diagrams changed by −3 to +2 %, and compact does not optimize deployment diagrams, so those two stay as they are).
  // The pane is named, not measured, so a prerendered figure and a live one are the same drawing. A view with a stored
  // layout keeps the drawing its positions were stored against, the editor's.
  var COMPACT_FIGURE = Object.freeze({ notations: { 'uml-class': true, 'uml-component': true }, directive: 'layout compact 600x700' });

  /** Whether a figure of `viewModel` (`options.compact`) is drawn in compact layout. */
  function drawsCompact(viewModel, options) {
    var stored = viewModel.layout && (viewModel.layout.positions.size > 0 || viewModel.layout.routes.length > 0);
    return Boolean(options && options.compact) && COMPACT_FIGURE.notations[viewModel.notation] === true && !stored;
  }

  /**
   * `text` with the compact directive as its last line before `@enduml`, so the lines the renderers number
   * (`rel:<line>`) keep their numbers and the source map still describes them.
   */
  function withCompactLayout(text) {
    return text.replace(/\n@enduml$/, '\n' + COMPACT_FIGURE.directive + '\n@enduml');
  }

  /**
   * Shows the view's figure in the C4 container and draws the view's ArchUML text into it once, with the ArchUML
   * renderer of its notation, leaving out every stored route whose line no longer joins its two boxes
   * (`UMLShared.renderSkippingDetachedRoutes`; spec §6 rule 5): such a line keeps the renderer's own route. With
   * `options.compact` a code or interfaces view without a stored layout is drawn in compact layout (`drawsCompact`).
   * Returns `{ uml, svg, skippedRouteIds }`: the `toUml` result drawn, the drawing (null when none), and the ids
   * (`rel:<line>`) of the stored routes left out.
   */
  function drawFigure(container, viewModel, options) {
    var shared = root.UMLShared;
    var uml = core.toUml(withTechnologyLabels(viewModel));
    var text = drawsCompact(viewModel, options) ? withCompactLayout(uml.text) : uml.text;
    var parts = figureParts(viewModel);
    shared.prepareDiagramContainer(container, 'c4');
    container.classList.add('uml-c4-diagram-container');
    container.replaceChildren(parts.content);
    var skippedRouteIds = shared.renderSkippingDetachedRoutes(function () {
      root[DELEGATED_RENDERERS[viewModel.notation]].render(parts.inner, text);
    });
    shared.autoFitSVG(container);
    return { uml: uml, svg: parts.inner.querySelector('svg'), skippedRouteIds: skippedRouteIds };
  }

  // ---- Stored bends that no longer join their boxes (UML-view editing spec §6 rule 5) ---------------------------

  /**
   * The stored route a line of the drawn text stands for, from its source-map entry (spec §4.1, §4.2): a code view's
   * relation line by its drawn ends and relation, a deployment view's link line by its ends as a `link` between nodes
   * or a `derived` path between hosted instances.
   */
  function routeOfLine(entry) {
    var relation = entry.kind === 'link' ? (entry.derived ? 'derived' : 'link') : entry.relation;
    return { from: entry.from, to: entry.to, relation: relation };
  }

  var LINE_ROUTE_ID = /^rel:(\d+)$/;

  /** The stored route (`{ from, to, relation }`) of route id `rel:<line>` of `uml`, the drawn `toUml` result. */
  function routeOfRouteId(uml, routeId) {
    return routeOfLine(uml.source.lines[Number(LINE_ROUTE_ID.exec(routeId)[1])]);
  }

  /** `viewModel` without the stored routes `dropped` (`{ from, to, relation }`) in its layout entry. */
  function withoutRoutes(viewModel, dropped) {
    var isDropped = function (route) {
      return dropped.some(function (key) { return key.from === route.from && key.to === route.to && key.relation === route.relation; });
    };
    var routes = viewModel.layout.routes.filter(function (route) { return !isDropped(route); });
    return Object.assign({}, viewModel, { layout: Object.assign({}, viewModel.layout, { routes: routes }) });
  }

  /**
   * Draws a code, dynamic, deployment, or interfaces view into `container` (spec §6, §7.1): the ArchUML text `toUml`
   * writes for it, with the view's layout entry as its layout block, through the ArchUML renderer of its notation, in
   * an inner element of the C4 container (an interfaces view with its title, legend, and notes around it). The view is
   * drawn once (spec §7.9). A stored bend whose line no longer has an end on the border of its end box (measured with
   * `UMLShared.renderedLayoutBox` while the renderer applies the stored routes) is left out of that drawing: the line
   * keeps the renderer's own route, as if the bend had never been stored. The check measures the drawing, so
   * `container` must be in the document. Returns `{ svgText, uml, droppedRoutes }`: the drawing's standalone SVG (null
   * when the renderer drew none), the `toUml` result the drawing shows (ids and source map included; its layout block
   * without the dropped bends), and the stored routes left out, as `{ from, to, relation }`. `options` keeps the
   * renderer's call shape; the UML renderers take their colours from the page. The drawing is not named and not marked
   * for print: `render` does both, and so does the editor's canvas. `render` also asks for `options.compact`: a figure
   * of a code or interfaces view without a stored layout is drawn in compact layout; the editor's canvas is not, since
   * its gestures store positions against the plain drawing.
   */
  function renderDelegatedView(container, viewModel, options) {
    var drawn = drawFigure(container, viewModel, options);
    var dropped = drawn.skippedRouteIds.map(function (routeId) { return routeOfRouteId(drawn.uml, routeId); });
    var uml = dropped.length > 0 ? core.toUml(withTechnologyLabels(withoutRoutes(viewModel, dropped))) : drawn.uml;
    return { svgText: drawn.svg ? drawn.svg.outerHTML : null, uml: uml, droppedRoutes: dropped };
  }

  function paragraph(className, text) {
    var element = document.createElement('p');
    element.className = className;
    element.textContent = text;
    return element;
  }

  /** The items of the description's sections named `heading`, in order. */
  function describedItems(description, heading) {
    return description.sections.filter(function (section) { return section.heading === heading; })
      .reduce(function (items, section) { return items.concat(section.items); }, []);
  }

  /**
   * The embed's text as an inert JSON string; `<` is escaped so the text cannot close the script element. Edge
   * groups of the drawing carry `data-c4-source` too (the id of the relationship's source element), and they come
   * first, so readers select `script[type="application/json"][data-c4-source]` and `JSON.parse` its text.
   */
  function appendSource(container, text) {
    var script = document.createElement('script');
    script.type = 'application/json';
    script.setAttribute('data-c4-source', '');
    script.textContent = JSON.stringify(text).replace(/</g, '\\u003c');
    container.appendChild(script);
  }

  /** Removes the diagnostics list an earlier render placed after `container`. */
  function removeDiagnostics(container) {
    var next = container.nextElementSibling;
    if (next && next.classList.contains('c4-diagnostics')) next.remove();
  }

  /**
   * Diagnostics appear only in an embed that asks for them with `# diagnostics: true`. The list follows the image
   * container, because inside a `role="img"` element it would be presentational and assistive technology could not
   * read it; a container without a parent has no place for it.
   */
  function appendDiagnostics(container, design) {
    var list = document.createElement('ul');
    list.className = 'c4-diagnostics';
    core.check(design).forEach(function (diagnostic) {
      var item = document.createElement('li');
      item.textContent = diagnostic.severity + ': ' + diagnostic.message + (diagnostic.range ? ' (line ' + diagnostic.range.start.line + ')' : '');
      list.appendChild(item);
    });
    if (list.children.length) container.after(list);
  }

  /**
   * Renders an embed's text: the view its top-level `view:` names, else the model's default view, with the pins
   * the model's `layout:` section keeps for that view's key (spec §6.4 step 5) unless `options.pins` gives others
   * (an editor's move preview). `options.palette` and `options.interactive` are as for `renderView`. A view in UML
   * notation is drawn by `renderDelegatedView`, with the layout its key keeps (an interfaces view with its title,
   * legend, and notes around it; a code or interfaces view without one in compact layout, `COMPACT_FIGURE`), and a YAML error, an unknown view, or an empty model shows an accessible state instead. A drawn figure is labelled once, here, through
   * `UMLShared.applySvgAccessibility(container, 'c4', text, brief)` (spec §3.3 step 2), so a page's describer
   * describes the same text. An interface card is text, not a drawing, so it is not labelled; the embed's
   * `# panels:` directive is written to `data-c4-panels` and chooses the card's panels (spec §6.6 item 7). A drawing
   * too wide to print its smallest text at 9 pt in a portrait column is marked for a landscape page
   * (`markPrintOrientation`). Returns `{ svgText, viewModel, brief }`; `svgText` is null for a card or a state, and
   * `brief` null for a state.
   */
  function render(container, text, options) {
    container.removeAttribute('data-c4-state');
    container.removeAttribute('data-c4-notation');
    removeDiagnostics(container);
    var panels = embedDirective(text, 'panels');
    if (panels === null) container.removeAttribute('data-c4-panels');
    else container.setAttribute('data-c4-panels', panels);
    var design = core.load(text);
    var selector = core.extractEmbed(text).selector || core.defaultView(design);
    var viewModel = core.project(design, selector);
    var state = embedState(design, viewModel, selector);
    var svgText = null;
    if (state) {
      showState(container, state);
    } else if (viewModel.notation === 'interface-card') {
      card.renderCard(container, viewModel, { panels: panels });
    } else if (DELEGATED_RENDERERS[viewModel.notation]) {
      svgText = renderDelegatedView(container, viewModel, Object.assign({}, options, { compact: true })).svgText;
    } else if (viewModel.notation === 'c4') {
      var pins = (options && options.pins) || design.model.layout.get(viewModel.key);
      svgText = renderView(container, viewModel, Object.assign({}, options, { pins: pins })).svgText;
    } else {
      throw new Error('ArchUMLC4Render does not draw ' + viewModel.notation + ' views yet.');
    }
    if (svgText !== null) markPrintOrientation(container);
    appendSource(container, text);
    if (/^true$/i.test(embedDirective(text, 'diagnostics') || '') && design.model !== null) appendDiagnostics(container, design);
    var brief = state ? null : core.describe(viewModel, { panels: panels || undefined }).brief;
    if (brief !== null && viewModel.notation !== 'interface-card') root.UMLShared.applySvgAccessibility(container, 'c4', text, brief);
    return { svgText: svgText, viewModel: viewModel, brief: brief };
  }

  return {
    PALETTE: PALETTE,
    contrastReport: contrastReport,
    escapeSvgText: escapeSvgText,
    cardMarkup: card.cardMarkup,
    renderCard: card.renderCard,
    layoutView: layoutView,
    seedPositions: seedPositions,
    renderView: renderView,
    renderDelegatedView: renderDelegatedView,
    render: render,
    markPrintOrientation: markPrintOrientation,
  };
});
