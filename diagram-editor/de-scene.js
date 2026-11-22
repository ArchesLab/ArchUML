(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./de-geometry.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.scene) parts.scene = factory(parts.geometry);
  }
})(typeof self !== 'undefined' ? self : this, function (geometry) {
  'use strict';

  // The scene (UML-view editing spec §2.1, §2.2; plan Task 22): what one drawing shows and where, read from its SVG
  // and the contents() an adapter gives for the document it draws. Its items are the drawn boxes an editor can
  // select and move, its routes the drawn lines; it resolves a drawn line to the relation it stands for and a height
  // in a sequence drawing to an insertion anchor, and it finds what holds a point. It changes nothing, decides
  // nothing, and reads the drawing when it is asked, so a drawing a drag has moved is read as it is now. The one thing
  // it draws is the target marks of a gesture with an open end (spec §7.4; plan Task 38), into the edit layer it is
  // given: the marks show the adapter's advice and decide nothing either.
  //
  // The functions came from the inline script of _includes/uml-editor.html without a changed statement (spec §3.6),
  // with the drawing, the contents, and the bundle as parameters. Matching a drawn line to a relation now reads the
  // relations of contents() (`{ line, from, to, label }`), which are each relation line's ends as the renderer
  // draws them: the lines the editor matched before.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var containsPoint = geometry.containsPoint;
  var containsBox = geometry.containsBox;
  var unionBox = geometry.unionBox;
  var overlaps = geometry.overlaps;
  var routeEndpointTouchesItem = geometry.routeEndpointTouchesItem;

  function cssAttrEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }

  // ─── Stored lines (moved from text/te-read.js by plan Task 38; they know no grammar) ───
  // The key under which the stored routes `routes` hold the drawn line `route`: its id, else `edge-<index>` or
  // `<index>` when the routes hold that key, else its id.
  function layoutRouteStorageKey(routes, route) {
    if (!route) return '';
    var id = String(route.id || '');
    if (id && routes && Object.prototype.hasOwnProperty.call(routes, id)) return id;
    var index = route.index;
    if (index !== undefined && index !== null && isFinite(Number(index))) {
      var edgeKey = 'edge-' + Number(index);
      if (routes && Object.prototype.hasOwnProperty.call(routes, edgeKey)) return edgeKey;
      var numericKey = String(Number(index));
      if (routes && Object.prototype.hasOwnProperty.call(routes, numericKey)) return numericKey;
    }
    return id;
  }
  // A route's points copied, with the bundle's copy when it has one.
  function clonePointsOf(points, bundle) {
    if (bundle.UMLShared && bundle.UMLShared.cloneRoutePoints) {
      return bundle.UMLShared.cloneRoutePoints(points);
    }
    return (points || []).map(function (p) { return { x: Number(p.x) || 0, y: Number(p.y) || 0 }; });
  }

  // ─── Measuring the drawing ───
  function svgPoint(svg, clientX, clientY) {
    var pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    var ctm = svg.getScreenCTM();
    return ctm ? pt.matrixTransform(ctm.inverse()) : { x: clientX, y: clientY };
  }
  function clientRectToSvgBox(svg, rect) {
    var p1 = svgPoint(svg, rect.left, rect.top);
    var p2 = svgPoint(svg, rect.right, rect.bottom);
    var x = Math.min(p1.x, p2.x);
    var y = Math.min(p1.y, p2.y);
    return { x: x, y: y, width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y) };
  }
  function cssTranslateOffset(svg, el) {
    var dx = 0;
    var dy = 0;
    var cur = el;
    while (cur && cur !== svg && cur.nodeType === 1) {
      var styleTransform = cur.style ? (cur.style.transform || '') : '';
      styleTransform.replace(/translate\(\s*(-?\d+(?:\.\d+)?)px(?:\s*,\s*|\s+)(-?\d+(?:\.\d+)?)px\s*\)/g, function (_, x, y) {
        dx += Number(x);
        dy += Number(y);
        return '';
      });
      cur = cur.parentNode;
    }
    if (!dx && !dy) return { x: 0, y: 0 };
    var ctm = svg && svg.getScreenCTM ? svg.getScreenCTM() : null;
    return {
      x: dx / (ctm && ctm.a ? ctm.a : 1),
      y: dy / (ctm && ctm.d ? ctm.d : 1)
    };
  }
  function elementSvgBox(svg, el) {
    if (!el || !el.getBoundingClientRect) return safeBBox(el);
    var rect = el.getBoundingClientRect();
    var box = (!rect || rect.width <= 0 || rect.height <= 0) ? safeBBox(el) : clientRectToSvgBox(svg, rect);
    if (!box) return null;
    var cssOffset = cssTranslateOffset(svg, el);
    if (cssOffset.x || cssOffset.y) {
      box = { x: box.x + cssOffset.x, y: box.y + cssOffset.y, width: box.width, height: box.height };
    }
    return box;
  }
  function safeBBox(el) {
    try {
      var b = el.getBBox();
      if (!isFinite(b.x) || !isFinite(b.y) || b.width <= 0 || b.height <= 0) return null;
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    } catch (e) {
      return null;
    }
  }
  function textOf(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function layoutElementsForId(svg, id) {
    id = String(id || '');
    return Array.prototype.slice.call(svg.querySelectorAll('[data-layout-id]')).filter(function (el) {
      return el.getAttribute('data-layout-id') === id && !el.closest('defs') && !el.closest('.uml-pg-edit-layer');
    });
  }
  function layoutBoundsElementsForId(svg, id) {
    id = String(id || '');
    return Array.prototype.slice.call(svg.querySelectorAll('[data-layout-bounds-id]')).filter(function (el) {
      return el.getAttribute('data-layout-bounds-id') === id && !el.closest('defs') && !el.closest('.uml-pg-edit-layer');
    });
  }
  function unionElementsBox(svg, elements) {
    var dataBox = null;
    elements.forEach(function (el) {
      var box = elementSvgBox(svg, el);
      if (box) dataBox = dataBox ? unionBox(dataBox, box) : box;
    });
    return dataBox;
  }
  function expandStackedRects(svg, box) {
    var rects = Array.prototype.slice.call(svg.querySelectorAll('rect')).map(function (r) {
      return { el: r, box: elementSvgBox(svg, r) };
    }).filter(function (r) { return r.box; });
    var expanded = box;
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < rects.length; i++) {
        var rb = rects[i].box;
        var sameColumn = Math.abs(rb.x - expanded.x) < 1.5 && Math.abs(rb.width - expanded.width) < 1.5;
        var touches = rb.y <= expanded.y + expanded.height + 1.5 && rb.y + rb.height >= expanded.y - 1.5;
        if (sameColumn && touches && !containsBox(expanded, rb, 0.5)) {
          expanded = unionBox(expanded, rb);
          changed = true;
        }
      }
    }
    return expanded;
  }
  /** The drawn box of `element` (`{ id, label }`): by its layout id (a class by its bounds id), else by its label. */
  function findRenderedBox(svg, element) {
    var dataEls = layoutElementsForId(svg, element.id);
    if (dataEls.length) {
      var bounds = layoutBoundsElementsForId(svg, element.id);
      var dataBox = unionElementsBox(svg, bounds.length ? bounds : dataEls);
      if (dataBox) return dataBox;
    }

    var labels = [element.label, element.id].filter(Boolean).map(function (s) {
      return String(s).replace(/\s+/g, ' ').trim();
    });
    var allTexts = Array.prototype.slice.call(svg.querySelectorAll('text')).filter(function (t) {
      return !t.closest('.uml-pg-edit-layer') && !t.closest('defs');
    });

    // Split candidate texts into exact and partial matches. The text-based
    // heuristic must prefer texts that are *equal* to the label over texts
    // that only contain it as a substring — otherwise an actor named
    // `User` happily latches on to a use case `"Manage Users"` (because
    // "Manage Users" contains "User"), and the resulting hitbox sits on
    // top of the wrong shape with no way to drag the actor itself.
    var exactTexts = allTexts.filter(function (t) {
      var txt = textOf(t);
      return labels.some(function (label) { return txt === label; });
    });
    var partialTexts = allTexts.filter(function (t) {
      var txt = textOf(t);
      if (labels.some(function (label) { return txt === label; })) return false;
      return labels.some(function (label) { return txt.indexOf(label) !== -1; });
    });
    if (!exactTexts.length && !partialTexts.length) return null;

    var shapes = Array.prototype.slice.call(svg.querySelectorAll('rect,circle,ellipse,polygon,path')).filter(function (el) {
      return !el.closest('.uml-pg-edit-layer') && !el.closest('defs');
    }).map(function (el) {
      return { el: el, box: elementSvgBox(svg, el) };
    }).filter(function (item) { return item.box; });

    function bestForTexts(texts) {
      var local = null;
      for (var ti = 0; ti < texts.length; ti++) {
        var tb = elementSvgBox(svg, texts[ti]);
        if (!tb) continue;
        var cx = tb.x + tb.width / 2;
        var cy = tb.y + tb.height / 2;
        var foundShape = false;
        for (var si = 0; si < shapes.length; si++) {
          var sb = shapes[si].box;
          if (!containsPoint(sb, cx, cy, 4)) continue;
          var area = sb.width * sb.height;
          if (area < Math.max(80, tb.width * tb.height * 1.2)) continue;
          // Real shape always beats a text-bounds fallback (which carries
          // area=0 and would otherwise dominate via `area < best.area`).
          if (!local || local.fallback || area < local.area) {
            local = { box: sb, area: area, fallback: false };
          }
          foundShape = true;
        }
        if (!foundShape && !local) {
          local = {
            box: { x: tb.x - 12, y: tb.y - 10, width: tb.width + 24, height: tb.height + 20 },
            area: 0,
            fallback: true
          };
        }
      }
      return local;
    }

    var best = bestForTexts(exactTexts) || bestForTexts(partialTexts);
    return best ? expandStackedRects(svg, best.box) : null;
  }

  // ─── Items and routes ───
  // An element of contents() as the classic canvas names its movement: a lifeline moves along x,
  // a git graph's branch label is a branch label.
  function classicModelOf(element) {
    var axis = element.axis === 'order' ? 'x' : element.axis === 'label' && element.kind === 'branch' ? 'branch-label' : element.axis;
    return { id: element.id, label: element.label, axis: axis };
  }
  /**
   * The drawn boxes of `contents`' elements that can move, and the drawn labels of relations: `{ id, label, axis,
   * box, parent }`, and for a port its component's box and the side of it the port sits on.
   */
  function editableItems(svg, contents) {
    if (!svg) return [];
    var models = contents.elements.map(classicModelOf);
    var found = [];
    for (var i = 0; i < models.length; i++) {
      if (models[i].axis === 'none') continue;
      var box = findRenderedBox(svg, models[i]);
      if (box) {
        var item = { id: models[i].id, label: models[i].label, axis: models[i].axis, box: box, parent: models[i].parent };
        if (models[i].axis === 'port') {
          item.parent = models[i].id.split('.')[0];
          item.parentBox = findRenderedBox(svg, { id: item.parent, label: item.parent });
          if (item.parentBox) {
            var pcx = box.x + box.width / 2;
            var pcy = box.y + box.height / 2;
            var sideDistances = [
              { side: 'left', distance: Math.abs(pcx - item.parentBox.x) },
              { side: 'right', distance: Math.abs(pcx - (item.parentBox.x + item.parentBox.width)) },
              { side: 'top', distance: Math.abs(pcy - item.parentBox.y) },
              { side: 'bottom', distance: Math.abs(pcy - (item.parentBox.y + item.parentBox.height)) }
            ];
            sideDistances.sort(function (a, b) { return a.distance - b.distance; });
            item.portSide = sideDistances[0].side;
          }
        }
        found.push(item);
      }
    }
    Array.prototype.slice.call(svg.querySelectorAll('[data-layout-kind="edge-label"][data-layout-id]')).forEach(function (el) {
      if (el.closest('defs') || el.closest('.uml-pg-edit-layer')) return;
      var id = el.getAttribute('data-layout-id') || '';
      if (!id) return;
      var box = unionElementsBox(svg, [el]);
      if (!box) return;
      found.push({ id: id, label: textOf(el) || id, axis: 'label', box: box });
    });
    return found;
  }
  /** The drawn lines an editor can select and bend; in a sequence drawing only the messages. */
  function editableRoutes(svg, type, bundle) {
    if (type === 'crc') return [];
    if (!bundle.UMLShared || !bundle.UMLShared.collectEditableRoutes) return [];
    var routes = bundle.UMLShared.collectEditableRoutes(svg);
    if ((type || '') === 'sequence') {
      return routes.filter(function (route) {
        return /^seqmsg:\d+$/.test(String(route.id || ''));
      });
    }
    return routes;
  }
  // A fragment of contents() as the classic canvas holds a fragment's range: its first branch's
  // guard is the fragment's condition, and its other branches are its else lines.
  function classicFragmentRange(fragment) {
    return {
      id: fragment.id,
      startIdx: fragment.startLine,
      kind: fragment.operator,
      condition: fragment.branches[0].guard,
      branches: fragment.branches.slice(1).map(function (branch) { return { lineIdx: branch.line, condition: branch.guard }; }),
      endIdx: fragment.endLine
    };
  }
  function findRenderedFragments(svg) {
    if (!svg) return [];
    var byId = {};
    Array.prototype.slice.call(svg.querySelectorAll('[data-layout-fragment-id]')).forEach(function (el) {
      if (el.closest('defs') || el.closest('.uml-pg-edit-layer')) return;
      var id = el.getAttribute('data-layout-fragment-id');
      if (!id) return;
      var bb = null;
      try { bb = el.getBBox(); } catch (e) { bb = null; }
      if (!bb) return;
      if (!byId[id]) byId[id] = { id: id, frameBox: null, labelBox: null };
      var tag = el.tagName.toLowerCase();
      if (tag === 'rect') byId[id].frameBox = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
      else if (tag === 'polygon') byId[id].labelBox = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
    });
    return Object.keys(byId).map(function (id) { return byId[id]; }).filter(function (f) {
      return f.frameBox && f.labelBox;
    });
  }
  /**
   * The drawn activation bars of a sequence drawing whose document has the framed `lines`:
   * { id, startLine, endLine, pIdx, target, box } with box in user space.
   */
  function findRenderedActivationBars(svg, lines) {
    if (!svg) return [];
    return Array.prototype.slice.call(svg.querySelectorAll('rect[data-layout-kind="activation"]'))
      .filter(function (el) { return !el.closest('defs') && !el.closest('.uml-pg-edit-layer'); })
      .map(function (el) {
        var bb = null;
        try { bb = el.getBBox(); } catch (e) { bb = null; }
        if (!bb) return null;
        var startLine = Number(el.getAttribute('data-activation-start-line'));
        if (!isFinite(startLine) || startLine < 0) return null;
        var endAttr = el.getAttribute('data-activation-end-line');
        var endLine = (endAttr === '' || endAttr == null) ? null : Number(endAttr);
        if (endLine != null && !isFinite(endLine)) endLine = null;
        var target = '';
        if (startLine < lines.length) {
          var m = String(lines[startLine] || '').trim().match(/^activate\s+(\S+)/i);
          target = m ? m[1] : '';
        }
        return {
          id: el.getAttribute('data-layout-id') || ('actbar:' + startLine),
          startLine: startLine,
          endLine: endLine,
          pIdx: Number(el.getAttribute('data-activation-pidx')) || 0,
          target: target,
          box: { x: bb.x, y: bb.y, width: bb.width, height: bb.height }
        };
      })
      .filter(Boolean);
  }

  // ─── A drawn line and the relation it stands for (spec §3.4, relation reference) ───
  // A reading here is what the matching needs of contents(): `type`, `lines` (the document without its
  // layout metadata), `relations`, and `elements`.
  function lineMentionsId(line, id) {
    var t = line.trim();
    if (!t || /^@/.test(t)) return false;
    // Match whole-word occurrences of id (alphanumeric + underscore boundary aware).
    var re = new RegExp('(^|[^\\w.])' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^\\w])');
    return re.test(t) || t.indexOf('"' + id + '"') !== -1;
  }
  function drawnRouteEndpoints(svg, routeId, lines, bundle) {
    const usecase = routeId.match(/^usecase:(\d+)$/);
    if (usecase) {
      // Use-case routes carry no endpoint attributes; the ordinal indexes
      // the parser's relationships.
      const relationship = bundle.UMLUseCaseDiagram.parse(lines.join('\n')).relationships[Number(usecase[1])];
      return relationship ? { source: relationship.from, target: relationship.to, label: '' } : null;
    }
    const selector = '[data-layout-route-id="' + cssAttrEscape(routeId) + '"]';
    const route = svg && svg.querySelector(selector + '[data-layout-source]');
    if (!route) return null;
    const label = svg.querySelector(selector + '[data-layout-kind="edge-label"]');
    return {
      source: route.getAttribute('data-layout-source'),
      target: route.getAttribute('data-layout-target'),
      label: label ? label.textContent.trim() : ''
    };
  }
  function routeIdIsDrawn(svg, routeId) {
    return !!svg.querySelector('[data-layout-route-id="' + cssAttrEscape(routeId) + '"]');
  }
  // The route collector numbers a line the renderer draws without an id,
  // such as a line of a generalization tree, so its id names no endpoints.
  // It can stand for each relation without a named route whose ends include
  // every element the line touches: the lines of those relations. A line
  // that touches nothing has none; one shared by several such relations (a
  // tree's trunk) has several.
  function relationLinesForUnnamedRoute(svg, routeId, reading, bundle) {
    const routes = editableRoutes(svg, reading.type, bundle);
    const route = routes.find(function (candidate) { return candidate.id === routeId; });
    if (!route) return [];
    const touched = editableItems(svg, reading).filter(function (item) {
      return item.axis !== 'label' && item.axis !== 'branch-label' &&
        (routeEndpointTouchesItem(route, 0, item) || routeEndpointTouchesItem(route, route.points.length - 1, item));
    }).map(function (item) { return item.id; });
    if (!touched.length) return [];
    const named = {};
    routes.forEach(function (other) {
      if (routeIdIsDrawn(svg, other.id)) named[relationLineMatch(svg, String(other.id), reading, bundle).lineIdx] = true;
    });
    const candidates = reading.relations.filter(function (relation) {
      return !named[relation.line] && touched.every(function (id) { return id === relation.from || id === relation.to; });
    });
    return candidates.map(function (relation) { return relation.line; });
  }
  // edge-N and usecase:N count routes in the renderer's drawing or parse
  // order, not source lines. The route can stand for each relation line
  // whose endpoints (and, between the same pair, label) match the drawn
  // route; a flow with no line of its own has none.
  function relationLinesForOrdinalRoute(svg, routeId, reading, bundle) {
    if (svg && /^edge-\d+$/.test(routeId) && !routeIdIsDrawn(svg, routeId)) {
      return relationLinesForUnnamedRoute(svg, routeId, reading, bundle);
    }
    const drawn = drawnRouteEndpoints(svg, routeId, reading.lines, bundle);
    if (!drawn) return [];
    let candidates = reading.relations.filter(function (relation) {
      return relation.from === drawn.source && relation.to === drawn.target;
    });
    if (candidates.length > 1 && drawn.label) {
      candidates = candidates.filter(function (relation) { return relation.label === drawn.label; });
    }
    return candidates.map(function (relation) { return relation.line; });
  }
  // The line a drawn route resolves to (`lineIdx`, or -1 unless exactly one line matches), its text,
  // the relation lines the route can stand for (`candidates`), and the ends an edge:A|B id names.
  function relationLineMatch(svg, routeId, reading, bundle) {
    var lines = reading.lines;
    var result = { sourceId: null, targetId: null, lineIdx: -1, lineText: '', candidates: [] };
    var id = String(routeId || '');
    var sequenceMatch = reading.type === 'sequence' ? id.match(/^seqmsg:(\d+)$/) : null;
    if (sequenceMatch) {
      var seqIdx = Number(sequenceMatch[1]);
      if (lines[seqIdx] != null) {
        result.lineIdx = seqIdx;
        result.lineText = lines[seqIdx];
        result.candidates = [seqIdx];
        return result;
      }
    }

    var sourceLineMatch = id.match(/^rel:(\d+)$/);
    if (sourceLineMatch) {
      var relIdx = Number(sourceLineMatch[1]);
      if (lines[relIdx] != null) {
        result.lineIdx = relIdx;
        result.lineText = lines[relIdx];
        result.candidates = [relIdx];
        return result;
      }
    }

    var routeMatch = id.match(/^edge:([^|]+)\|([^|]+)$/);
    if (routeMatch) {
      result.sourceId = routeMatch[1];
      result.targetId = routeMatch[2];
      for (var i = 0; i < lines.length; i++) {
        if (lineMentionsId(lines[i], result.sourceId) && lineMentionsId(lines[i], result.targetId) &&
            /[-.<=>|*ox]/.test(lines[i]) && !/^@/.test(lines[i].trim())) {
          result.lineIdx = i;
          result.lineText = lines[i];
          result.candidates = [i];
          return result;
        }
      }
    }

    if (/^(?:edge[-:_]|usecase:)\d+$/.test(id)) {
      result.candidates = relationLinesForOrdinalRoute(svg, id, reading, bundle);
      result.lineIdx = result.candidates.length === 1 ? result.candidates[0] : -1;
      if (result.lineIdx !== -1) result.lineText = lines[result.lineIdx];
    }
    return result;
  }

  // ─── Insertion anchors of a sequence drawing ───
  function sequenceRouteLineIndex(routeId) {
    var match = String(routeId || '').match(/^seqmsg:(\d+)$/);
    return match ? Number(match[1]) : -1;
  }
  function sequenceRouteVisualY(route) {
    if (route && route.points && route.points[0]) return Number(route.points[0].y);
    if (route && route.box) return Number(route.box.y) + Number(route.box.height || 0) / 2;
    return 0;
  }
  /**
   * The line of the framed document (`reading.sequenceLines`) a message or fragment dropped at height `canvasY`
   * goes before, or null for the end of the document: the drawing then has no message, fragment edge, or else line.
   * The message `excludeRouteId` and the fragment `opts.excludeFragId`, the ones being moved, are no anchors.
   */
  function sequenceInsertLine(svg, canvasY, reading, bundle, excludeRouteId, opts) {
    opts = opts || {};
    var excludeFragId = opts.excludeFragId || null;
    var cleanLines = reading.sequenceLines;
    var candidates = editableRoutes(svg, reading.type, bundle).filter(function (route) {
      return /^seqmsg:\d+$/.test(String(route.id || '')) && route.id !== excludeRouteId;
    }).map(function (route) {
      return { lineIdx: sequenceRouteLineIndex(route.id), y: sequenceRouteVisualY(route) };
    }).filter(function (entry) {
      return entry.lineIdx >= 0 && entry.lineIdx < cleanLines.length;
    });

    // Fragment boundary anchors — without these, dropping a message above
    // an alt or below the last branch silently lands inside the fragment
    // because the algorithm only sees message Ys. Adding boundary anchors
    // makes the frame edges and else dividers act as drop dividers.
    var fragRanges = reading.fragments.map(classicFragmentRange);
    var renderedById = {};
    findRenderedFragments(svg).forEach(function (f) { renderedById[f.id] = f; });
    fragRanges.forEach(function (frag) {
      if (frag.id === excludeFragId) return;
      var rendered = renderedById[frag.id];
      if (!rendered || !rendered.frameBox) return;
      var box = rendered.frameBox;
      // Frame top → insert before opener (drop above the fragment).
      candidates.push({ lineIdx: frag.startIdx, y: box.y });
      // Frame bottom → insert before `end` (drop in last branch, just above frame edge).
      candidates.push({ lineIdx: frag.endIdx, y: box.y + box.height });
      // Else dividers — dashed lines tagged with branch line index.
      if (frag.branches && frag.branches.length) {
        var sel = 'line[data-layout-fragment-id="' + cssAttrEscape(frag.id) + '"][data-layout-branch-line]';
        var elseEls = svg ? svg.querySelectorAll(sel) : [];
        Array.prototype.slice.call(elseEls).forEach(function (el) {
          var branchLineIdx = Number(el.getAttribute('data-layout-branch-line'));
          var elseY = Number(el.getAttribute('y1'));
          if (Number.isFinite(branchLineIdx) && Number.isFinite(elseY)) {
            candidates.push({ lineIdx: branchLineIdx, y: elseY });
          }
        });
      }
    });

    candidates.sort(function (a, b) {
      if (a.y !== b.y) return a.y - b.y;
      return a.lineIdx - b.lineIdx;
    });

    for (var i = 0; i < candidates.length; i++) {
      if (canvasY < candidates[i].y) return candidates[i].lineIdx;
    }
    if (candidates.length) return candidates[candidates.length - 1].lineIdx + 1;
    return null;
  }

  // ─── What holds a point ───
  function elementKindOf(contents, id) {
    var element = contents.elements.find(function (candidate) { return candidate.id === id; });
    return element ? element.kind : null;
  }
  /**
   * The element a port or an interface dropped at `pt` goes into (a component diagram: the topmost component, else
   * the topmost box that is no port or label), or that a component or an artifact goes into (a deployment diagram:
   * the topmost node); null for none, and in any other diagram.
   */
  function containerAt(svg, pt, contents) {
    if (!svg) return null;
    var editables = editableItems(svg, contents);
    var i;
    var e;
    if (contents.type === 'component') {
      var hit = null;
      // Iterate in reverse so visually-on-top components win.
      for (i = editables.length - 1; i >= 0; i--) {
        e = editables[i];
        if (e.axis === 'port' || e.axis === 'label' || e.axis === 'branch-label') continue;
        if (pt.x >= e.box.x && pt.x <= e.box.x + e.box.width &&
            pt.y >= e.box.y && pt.y <= e.box.y + e.box.height) {
          // Prefer components specifically.
          if (elementKindOf(contents, e.id) === 'component') return e.id;
          if (!hit) hit = e.id;
        }
      }
      // Fall back to any element if we didn't find a component (shouldn't happen).
      return hit;
    }
    if (contents.type === 'deployment') {
      for (i = editables.length - 1; i >= 0; i--) {
        e = editables[i];
        if (pt.x < e.box.x || pt.x > e.box.x + e.box.width ||
            pt.y < e.box.y || pt.y > e.box.y + e.box.height) continue;
        if (elementKindOf(contents, e.id) === 'node') return e.id;
      }
    }
    return null;
  }

  /**
   * The scene of one drawing: `svg` as the renderer drew `contents` with the page's `bundle`. Every member reads the
   * drawing when it is called. A member that resolves a reference takes the contents the caller read when it built
   * its operation, so the answer belongs to that reading.
   */
  function readScene(svg, contents, bundle) {
    function items() { return editableItems(svg, contents); }
    function routes() { return editableRoutes(svg, contents.type, bundle); }
    return {
      items: items,
      routes: routes,
      /** The drawn box of the element `ref` (by its layout id, a class by its bounds id), or of another layout id. */
      boxOf: function (ref) {
        var element = contents.elements.find(function (candidate) { return candidate.id === ref; });
        if (element) return findRenderedBox(svg, classicModelOf(element));
        return bundle.UMLShared && bundle.UMLShared.renderedLayoutBox ? bundle.UMLShared.renderedLayoutBox(svg, ref) : null;
      },
      /** The drawn route `ref`, or null. */
      routeOf: function (ref) {
        return routes().find(function (route) { return route.id === ref; }) || null;
      },
      /** The relation reference of the drawn route `routeId` in `reading`: `{ routeId, line, candidates }`. */
      relationRef: function (routeId, reading) {
        var match = relationLineMatch(svg, routeId, reading, bundle);
        return { routeId: routeId, line: match.lineIdx, candidates: match.candidates };
      },
      /** The whole match of the drawn route `routeId` in `reading`, with the line's text and an edge:A|B id's ends. */
      relationMatch: function (routeId, reading) {
        return relationLineMatch(svg, routeId, reading, bundle);
      },
      /**
       * The insertion anchor `{ beforeLine }` of height `y` in a sequence drawing of `reading`, against its framed
       * lines; `beforeLine` is null for the end of the document. `exclude` names the message (`route`) or the
       * fragment (`fragment`) that is being moved.
       */
      anchorAt: function (y, reading, exclude) {
        var leaveOut = exclude || {};
        return { beforeLine: sequenceInsertLine(svg, y, reading, bundle, leaveOut.route || null, { excludeFragId: leaveOut.fragment || null }) };
      },
      /** The element that holds point `point` for an addition (see containerAt), or null. */
      containerAt: function (point) { return containerAt(svg, point, contents); },
      /** The pairs of the items `ids` whose drawn boxes overlap, each pair in the order of `ids`. */
      overlapsAmong: function (ids) {
        var boxes = items().filter(function (item) { return ids.indexOf(item.id) !== -1; });
        boxes.sort(function (a, b) { return ids.indexOf(a.id) - ids.indexOf(b.id); });
        var pairs = [];
        for (var i = 0; i < boxes.length; i++) {
          for (var j = i + 1; j < boxes.length; j++) {
            if (overlaps(boxes[i].box, boxes[j].box)) pairs.push([boxes[i].id, boxes[j].id]);
          }
        }
        return pairs;
      }
    };
  }

  // ─── Target marks (spec §3.4 `targets`, §7.4 "Target marks"; plan Task 38) ───
  // A gesture with an open end asks the adapter's advice once, and each candidate of it is marked over its drawn box: a
  // possible target with a thick dashed outline, one that is not possible with a thin solid outline and a struck-through
  // circle on its corner, so the two differ by shape. A mark is drawing, not content: it is aria-hidden, and
  // css/diagram-editor.css lets every press pass through it and hides it in print.
  var TARGET_MARK = 'uml-pg-target-mark';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  // How far an outline lies outside its box, and the radius of the sign's circle, in the drawing's units.
  var TARGET_MARK_GAP = 4;
  var TARGET_SIGN_RADIUS = 9;

  /** The layout id a candidate's `ref` names: the ref itself, or its `id`. */
  function targetRefId(ref) {
    return ref !== null && typeof ref === 'object' ? ref.id : ref;
  }
  /** The candidates of an advice in keyboard order: the possible ones first, then the others, each in the advice's order. */
  function targetOrder(candidates) {
    return candidates.filter(function (candidate) { return candidate.ok; })
      .concat(candidates.filter(function (candidate) { return !candidate.ok; }));
  }
  function svgChild(doc, parent, tag, attributes) {
    var child = doc.createElementNS(SVG_NS, tag);
    Object.keys(attributes).forEach(function (name) { child.setAttribute(name, attributes[name]); });
    parent.appendChild(child);
    return child;
  }
  /** Removes every target mark from `layer`. */
  function clearTargetMarks(layer) {
    if (!layer) return;
    Array.prototype.slice.call(layer.querySelectorAll('.' + TARGET_MARK)).forEach(function (mark) { mark.remove(); });
  }
  /**
   * Marks in `layer` each candidate of `candidates` (`[{ ref, ok, code, summary }]`, an adapter's `targets` answer)
   * whose drawn box `boxOf(id)` gives, after taking away the marks drawn before, with the elements of `doc`. Returns
   * the candidates in keyboard order (targetOrder).
   */
  function markTargets(layer, candidates, boxOf, doc) {
    clearTargetMarks(layer);
    candidates.forEach(function (candidate) {
      var id = targetRefId(candidate.ref);
      var box = boxOf(id);
      if (!box) return;
      var mark = svgChild(doc, layer, 'g', {
        'class': TARGET_MARK + (candidate.ok ? ' is-possible' : ' is-not-possible'),
        'data-target-ref': id,
        'aria-hidden': 'true'
      });
      svgChild(doc, mark, 'rect', {
        'class': 'uml-pg-target-mark-outline',
        x: box.x - TARGET_MARK_GAP,
        y: box.y - TARGET_MARK_GAP,
        width: box.width + 2 * TARGET_MARK_GAP,
        height: box.height + 2 * TARGET_MARK_GAP,
        rx: TARGET_MARK_GAP
      });
      if (candidate.ok) return;
      var cx = box.x + box.width + TARGET_MARK_GAP;
      var cy = box.y - TARGET_MARK_GAP;
      var arm = TARGET_SIGN_RADIUS * Math.SQRT1_2;
      svgChild(doc, mark, 'circle', { 'class': 'uml-pg-target-mark-sign', cx: cx, cy: cy, r: TARGET_SIGN_RADIUS });
      svgChild(doc, mark, 'line', { 'class': 'uml-pg-target-mark-sign', x1: cx - arm, y1: cy - arm, x2: cx + arm, y2: cy + arm });
    });
    return targetOrder(candidates);
  }

  return {
    readScene: readScene,
    clearTargetMarks: clearTargetMarks,
    markTargets: markTargets,
    targetOrder: targetOrder,
    targetRefId: targetRefId,
    cssAttrEscape: cssAttrEscape,
    layoutRouteStorageKey: layoutRouteStorageKey,
    clonePointsOf: clonePointsOf,
    svgPoint: svgPoint,
    clientRectToSvgBox: clientRectToSvgBox,
    elementSvgBox: elementSvgBox,
    safeBBox: safeBBox,
    textOf: textOf,
    layoutElementsForId: layoutElementsForId,
    layoutBoundsElementsForId: layoutBoundsElementsForId,
    unionElementsBox: unionElementsBox,
    findRenderedBox: findRenderedBox,
    classicModelOf: classicModelOf,
    classicFragmentRange: classicFragmentRange,
    findRenderedFragments: findRenderedFragments,
    findRenderedActivationBars: findRenderedActivationBars,
    sequenceRouteLineIndex: sequenceRouteLineIndex,
    sequenceRouteVisualY: sequenceRouteVisualY,
    lineMentionsId: lineMentionsId
  };
});
