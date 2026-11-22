(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./te-read.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.textLayout) parts.textLayout = factory(parts.textRead);
  }
})(typeof self !== 'undefined' ? self : this, function (readPart) {
  // The layout rewrites (UML-view editing spec §3.4: layout.set, layout.reset, lifeline.reorder; plan Task 11): where boxes
  // and bends are stored, and the deployment nesting refusals of a move.
  //
  // Moved from the inline script of _includes/uml-editor.html without a changed statement (plan Task 21, spec
  // §3.6); every function reads only its arguments: the text, the diagram type, the operation, and the bundle.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var layoutRouteStorageKey = readPart.layoutRouteStorageKey;
  var textGrammar = readPart.textGrammar;

  // Deployment nesting lives in the source's braces, not in coordinates.
  // A move must therefore keep every element inside the node that contains
  // it, and must not look like it drops an element into a nested node.
  // `nesting` holds the scene facts of the move (spec §3.4, layout.set), one
  // per moved box: whether it still lies inside its parent's drawn box
  // (`insideParent`, null when its parent is not drawn) and which nested
  // node's drawn box holds its new centre (`nestedNodeAtCentre`, or null).
  function deploymentNestingRefusal(text, type, nesting, bundle) {
    if (!nesting.length) return null;
    var model = textGrammar.deploymentNesting(text, type, bundle);
    var moved = nesting.map(function (landing) { return landing.id; });
    function carried(id) {
      return model.ancestorsOf(id).some(function (ancestor) { return moved.indexOf(ancestor) !== -1; });
    }
    var advice = ' The visual editor does not change nesting; to move an element to another node, edit its declaration in the source.';
    for (var i = 0; i < nesting.length; i++) {
      var id = nesting[i].id;
      if (!model.byId[id] || carried(id)) continue;
      var parentId = model.byId[id].parentId;
      if (parentId && (model.isNestedNode(id) || model.isNestedNode(parentId)) && nesting[i].insideParent === false) {
        return {
          code: 'layout/inside-node',
          summary: 'Stays inside its node',
          message: 'Move cancelled: ' + (model.isNestedNode(id) ? 'nested node "' + model.label(id) + '"' : '"' + model.label(id) + '"') +
            ' belongs to ' + (model.isNestedNode(parentId) ? 'nested node ' : '') + '"' + model.label(parentId) + '".' + advice
        };
      }
      var nodeId = nesting[i].nestedNodeAtCentre;
      if (nodeId) {
        return {
          code: 'layout/onto-nested-node',
          summary: 'Not put inside that node',
          message: 'Move cancelled: dropping "' + model.label(id) + '" onto nested node "' + model.label(nodeId) + '" would not put it inside that node.' + advice
        };
      }
    }
    return null;
  }

  // layout.set: the moved boxes at their new places (in a deployment drawing only where nesting stays
  // as the source has it, and with the boxes they carry), the stored bends the move shifted, and the
  // bends the operation changes.
  function rewriteLayoutSet(text, type, operation, bundle) {
    var facts = operation.facts;
    if (type === 'deployment') {
      var refusal = deploymentNestingRefusal(text, type, facts.nesting, bundle);
      if (refusal) return { refusal: refusal };
    }
    var positions = Object.assign({}, facts.positions, operation.positions);
    if (type === 'deployment') Object.assign(positions, facts.carried);
    var routes = Object.assign(textGrammar.readLayoutRoutes(text, bundle), facts.shiftedRoutes);
    operation.routes.forEach(function (route) {
      routes[layoutRouteStorageKey(routes, route) || route.id] = { points: route.points };
    });
    return { text: textGrammar.writePositionsIntoSource(text, type, positions, routes, bundle), select: undefined, message: null };
  }

  // layout.reset: `target` is 'all' (every stored position and bend goes), `{ route }` (its stored
  // bends go), `{ label }` (its stored position goes), or `{ element }` (back to its automatic place,
  // or unpinned when the automatic layout has none). The other boxes keep where they are drawn: the
  // facts of a single reset are every drawn position, with a route's storage key or an element's
  // automatic place; a reset of all needs no fact.
  function rewriteLayoutReset(text, type, operation, bundle) {
    var target = operation.target;
    var facts = operation.facts;
    var after;
    if (target === 'all') {
      after = textGrammar.stripLayoutMetadata(text, type);
    } else if (target.route) {
      var routes = textGrammar.readLayoutRoutes(text, bundle);
      delete routes[facts.storageKey];
      if (facts.storageKey !== target.route) delete routes[target.route];
      after = textGrammar.writePositionsIntoSource(text, type, facts.positions, routes, bundle);
    } else if (target.label) {
      var withoutLabel = Object.assign({}, facts.positions);
      delete withoutLabel[target.label];
      after = textGrammar.writePositionsIntoSource(text, type, withoutLabel, undefined, bundle);
    } else {
      var positions = Object.assign({}, facts.positions);
      if (facts.automatic) positions[target.element] = facts.automatic;
      else delete positions[target.element];
      after = textGrammar.writePositionsIntoSource(text, type, positions, undefined, bundle);
    }
    return { text: after, select: null, message: null };
  }

  // lifeline.reorder: the lifelines' declaration lines in the order of `order`. Every lifeline of the
  // order loses its stored position, so the renderer lays the lifelines out afresh, and the stored
  // bends of messages go, since they belong to the old places.
  function rewriteLifelineReorder(text, type, operation, bundle) {
    var ordered = operation.order;
    var declarations = textGrammar.sequenceLifelineDeclarations(text, ordered, bundle);
    if (!declarations) throw new Error('lifeline.reorder needs a declaration line for every lifeline of its order.');
    var lines = declarations.lines;
    var declLineIdxs = declarations.indices;
    // Sort declLineIdxs ascending and replace in source order.
    declLineIdxs.sort(function (a, b) { return a - b; });
    ordered.forEach(function (id, i) {
      lines[declLineIdxs[i]] = declarations.lineById[id];
    });
    // Drop the @pos of every lifeline of the order, the dragged one among them, so the fresh layout is clean.
    var freshPositions = Object.assign({}, operation.facts.positions);
    ordered.forEach(function (id) { delete freshPositions[id]; });
    var routes = textGrammar.readLayoutRoutes(text, bundle);
    // Drop routes — message routes are tied to old positions and would draw wrong.
    Object.keys(routes).forEach(function (k) { delete routes[k]; });
    return { text: textGrammar.writePositionsIntoSource(lines.join('\n'), 'sequence', freshPositions, routes, bundle), select: undefined, message: null };
  }

  return {
    rewriteLayoutSet: rewriteLayoutSet,
    rewriteLayoutReset: rewriteLayoutReset,
    rewriteLifelineReorder: rewriteLifelineReorder
  };
});
