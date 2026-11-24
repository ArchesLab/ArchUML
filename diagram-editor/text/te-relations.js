(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./te-schemas.js'), require('./te-read.js'), require('./te-elements.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.textRelations) parts.textRelations = factory(parts.textSchemas, parts.textRead, parts.textElements);
  }
})(typeof self !== 'undefined' ? self : this, function (schemasPart, readPart, elementsPart) {
  // The relation rewrites (UML-view editing spec §3.4: relation.*; plan Task 14).
  //
  // Moved from the inline script of _includes/uml-editor.html without a changed statement (plan Task 21, spec
  // §3.6); every function reads only its arguments: the text, the diagram type, the operation, and the bundle.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var findRelationSchema = schemasPart.findRelationSchema;
  var sequenceSourceWithScaffold = readPart.sequenceSourceWithScaffold;
  var relationLineOptions = readPart.relationLineOptions;
  var relationOfLine = readPart.relationOfLine;
  var routeIdForRelationInfo = readPart.routeIdForRelationInfo;
  var clearRouteLayoutForRewire = readPart.clearRouteLayoutForRewire;
  var invertedRouteId = readPart.invertedRouteId;
  var reverseSavedRoute = readPart.reverseSavedRoute;
  var moveRelationLabelPosition = readPart.moveRelationLabelPosition;
  var textGrammar = readPart.textGrammar;
  var newestRelationSelection = elementsPart.newestRelationSelection;
  var UNKNOWN_UPDATE = elementsPart.UNKNOWN_UPDATE;

  // The refusals of the relation rewrites. Where today's commands said nothing, they say nothing.
  var UNKNOWN_RELATION_TOOL = { code: 'relation/tool', summary: 'Relation not available', message: 'The editor cannot draw this relation.' };
  var RELATION_UNMATCHED = { code: 'relation/unmatched', summary: 'Connection not found in the source', message: 'Could not locate that relation in the source.' };
  var RELATION_KIND_UNKNOWN = { code: 'relation/kind', summary: 'Relation type not available', message: null };
  var RELATION_UNCHANGED = { code: 'relation/unchanged', summary: 'Nothing to change', message: null };
  var CANNOT_REWIRE = { code: 'relation/kind', summary: 'Cannot rewire this relation', message: 'This relation type cannot be rewired from the visual editor.' };
  var CANNOT_INVERT = { code: 'relation/kind', summary: 'Cannot invert this relation', message: 'This relation type cannot be inverted from the visual editor.' };
  var NO_SOURCE_TO_SWAP = { code: 'relation/no-source', summary: 'No source to swap', message: 'This flow continues from the step before it, so it has no source to swap.' };

  // The document with the relation line at index `lineIdx` (of the document without its layout
  // metadata) replaced by `relationLine`, its indent kept, and the layout `positions` and `routes`.
  function withRelationLine(text, type, lineIdx, relationLine, positions, routes, bundle) {
    var lines = textGrammar.stripLayoutMetadata(text, type).split('\n');
    var indent = (lines[lineIdx].match(/^\s*/) || [''])[0];
    lines[lineIdx] = indent + relationLine;
    return textGrammar.writePositionsIntoSource(lines.join('\n'), type, positions, routes, bundle);
  }

  // The relation that the relation reference `ref` (`{ routeId, line, candidates }`) names in `text`.
  function referencedRelation(text, type, ref) {
    var lineText = ref.line === -1 ? '' : textGrammar.stripLayoutMetadata(text, type).split('\n')[ref.line];
    return relationOfLine(lineText, type, ref.routeId);
  }

  // relation.add: a line of the relation tool `tool` from `from` to `to`, labelled `label` or, when it
  // is null, as the tool labels a new line. A lost or found message names its one lifeline as both
  // ends. In a sequence diagram the scene fact `at` places a message before the line `at.beforeLine`
  // of the framed document, and that message is selected once drawn. Without it the line goes before
  // @enduml, and the newest relation line is selected (a lost or found message is not).
  function rewriteRelationAdd(text, type, operation, bundle) {
    var g = textGrammar;
    var spec = findRelationSchema(type, operation.tool);
    if (!spec) return { refusal: UNKNOWN_RELATION_TOOL };
    var labelled = operation.label == null ? {} : { label: operation.label };
    var at = operation.facts.at;
    if (at) {
      var framed = sequenceSourceWithScaffold(text);
      var lineCount = g.stripLayoutMetadata(framed, type).split('\n').length;
      var insertAt = Math.max(0, Math.min(lineCount, Math.round(Number(at.beforeLine))));
      return {
        text: g.addRelationToSource(framed, type, spec, operation.from, operation.to, Object.assign({ insertAtLine: insertAt }, labelled), bundle),
        select: { id: 'seqmsg:' + (insertAt + (spec.sequenceCreate ? 1 : 0)), kind: 'route' },
        message: null
      };
    }
    var added = g.addRelationToSource(text, type, spec, operation.from, operation.to, labelled, bundle);
    var singleMessage = type === 'sequence' && spec.sequenceSingle;
    return { text: added, select: singleMessage ? undefined : newestRelationSelection(added, type, bundle), message: null };
  }

  // relation.update: the line of the relation `ref` is rebuilt from `changes.relation`, the relation as
  // the Properties form or the in-place label editor holds it (its kind, ends, label, multiplicities,
  // navigabilities, stereotype, dashed outline, and guard; a name beyond spec §3.4's row, for plan
  // Task 48). The line is the one the reference resolved to when the form or the editor opened, as
  // today. The selection is left to the command.
  function rewriteRelationUpdate(text, type, operation, bundle) {
    var named = Object.keys(operation.changes || {});
    if (named.length !== 1 || named[0] !== 'relation') return { refusal: UNKNOWN_UPDATE };
    if (operation.ref.line === -1) return { refusal: RELATION_UNMATCHED };
    var relation = operation.changes.relation;
    var spec = findRelationSchema(type, relation.kind);
    if (!spec) return { refusal: RELATION_KIND_UNKNOWN };
    var g = textGrammar;
    var relationLine = g.buildRelationLine(spec, relation.source, relation.target, relationLineOptions(relation), type);
    return {
      text: withRelationLine(text, type, operation.ref.line, relationLine, g.readLayoutPositions(text, type, bundle), g.readLayoutRoutes(text, bundle), bundle),
      select: undefined,
      message: null
    };
  }

  // relation.rewire: the end `end` ('source', 'target', or a lost or found message's one 'endpoint')
  // of the relation `ref` moves to the element `to`. `relation` is the relation as the Properties form
  // holds it (beyond spec §3.4's row, for plan Task 48), which the rewired line is built from. The
  // route's stored bends and label place go, and the route is selected by its new id.
  function rewriteRelationRewire(text, type, operation, bundle) {
    var to = operation.to;
    if (operation.ref.line === -1) return { refusal: RELATION_UNMATCHED };
    if (!to) return { refusal: RELATION_UNCHANGED };
    var next = Object.assign({}, operation.relation);
    if (type === 'sequence' && /^(lost|found)$/.test(next.kind || '')) {
      if (next.source === to && next.target === to) return { refusal: RELATION_UNCHANGED };
      next.source = to;
      next.target = to;
    } else if (operation.end === 'source') {
      if (next.source === to) return { refusal: RELATION_UNCHANGED };
      next.source = to;
    } else {
      if (next.target === to) return { refusal: RELATION_UNCHANGED };
      next.target = to;
    }
    var spec = findRelationSchema(type, next.kind);
    if (!spec) return { refusal: CANNOT_REWIRE };
    var g = textGrammar;
    var routeId = operation.ref.routeId;
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    var nextRouteId = routeIdForRelationInfo(routeId, next);
    clearRouteLayoutForRewire(routes, positions, routeId, nextRouteId);
    var relationLine = g.buildRelationLine(spec, next.source, next.target, relationLineOptions(next), type);
    return {
      text: withRelationLine(text, type, operation.ref.line, relationLine, positions, routes, bundle),
      select: { id: nextRouteId, kind: 'route' },
      message: 'Rewired relation endpoint.'
    };
  }

  // relation.invert: the relation `ref` points the other way. Its ends and multiplicities swap (a lost
  // message becomes a found one, and back), its stored bends reverse, its label keeps its place, and
  // the route is selected by its new id.
  function rewriteRelationInvert(text, type, operation, bundle) {
    var info = referencedRelation(text, type, operation.ref);
    if (info.implicitSource) return { refusal: NO_SOURCE_TO_SWAP };
    if (operation.ref.line === -1 || !info.source || !info.target) return { refusal: RELATION_UNMATCHED };
    if (type === 'sequence' && (info.kind === 'lost' || info.kind === 'found')) {
      info.kind = info.kind === 'lost' ? 'found' : 'lost';
    } else {
      var oldSource = info.source;
      info.source = info.target;
      info.target = oldSource;
      var oldSourceMult = info.sourceMult;
      info.sourceMult = info.targetMult;
      info.targetMult = oldSourceMult;
    }
    var spec = findRelationSchema(type, info.kind);
    if (!spec) return { refusal: CANNOT_INVERT };
    var g = textGrammar;
    var routeId = operation.ref.routeId;
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    var nextRouteId = invertedRouteId(routeId);
    reverseSavedRoute(routes, routeId, nextRouteId, bundle);
    moveRelationLabelPosition(positions, routeId, nextRouteId);
    var relationLine = g.buildRelationLine(spec, info.source, info.target, relationLineOptions(info), type);
    return {
      text: withRelationLine(text, type, operation.ref.line, relationLine, positions, routes, bundle),
      select: { id: nextRouteId, kind: 'route' },
      message: 'Inverted relation direction.'
    };
  }

  return {
    rewriteRelationAdd: rewriteRelationAdd,
    rewriteRelationUpdate: rewriteRelationUpdate,
    rewriteRelationRewire: rewriteRelationRewire,
    rewriteRelationInvert: rewriteRelationInvert
  };
});
