(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./te-read.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.textSource) parts.textSource = factory(parts.textRead);
  }
})(typeof self !== 'undefined' ? self : this, function (readPart) {
  // The raw-source rewrites (UML-view editing spec §3.4: source.*; plan Task 16), which only the text adapter serves.
  //
  // Moved from the inline script of _includes/uml-editor.html without a changed statement (plan Task 21, spec
  // §3.6); every function reads only its arguments: the text, the diagram type, the operation, and the bundle.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var sourceWithScaffold = readPart.sourceWithScaffold;
  var textGrammar = readPart.textGrammar;

  // The raw-source family (spec §3.4; plan Task 16): the forms of the classic host that edit the
  // document by its lines (the line-model and sequence panels, the quick-insert buttons, the callouts
  // panel, and Properties fields that rebuild a declaration). Their lines are counted in the framed
  // document, the lines of `@startuml … @enduml` without the layout, as the panels list them; a line
  // operation writes the framed document back with the layout it had. The forms said nothing about a
  // line they could not find, and neither do these refusals.
  var SOURCE_LINE_MISSING = { code: 'source/range', summary: 'That line is not in the source', message: null };

  function framedSourceLines(text, type) {
    return textGrammar.stripLayoutMetadata(sourceWithScaffold(text), type).split('\n');
  }

  function isLineIndexOf(lines, index) {
    return index >= 0 && index < lines.length;
  }

  // The rewrite's result: `lines` as the document, with the stored layout of `text`.
  function linesWithStoredLayout(text, type, lines, bundle) {
    var g = textGrammar;
    var positions = g.readLayoutPositions(text, type, bundle);
    var routes = g.readLayoutRoutes(text, bundle);
    return { text: g.writePositionsIntoSource(lines.join('\n'), type, positions, routes, bundle), select: undefined, message: null };
  }

  function rewriteSourceReplace(text, type, operation) {
    return { text: operation.text, select: undefined, message: null };
  }

  // `lines` before the line `at.beforeLine` of the framed document, or with `at: 'end'` one by one
  // before its `@enduml` (or after its last line). `frame: false` keeps a document without its frame
  // as it is (the quick-insert buttons); the line-model panels frame it first.
  function rewriteSourceInsertLines(text, type, operation, bundle) {
    var g = textGrammar;
    if (operation.at === 'end') {
      var source = operation.frame ? sourceWithScaffold(text) : text;
      operation.lines.forEach(function (line) {
        source = g.appendRawLine(source, type, line, bundle);
      });
      return { text: source, select: undefined, message: null };
    }
    var lines = operation.frame ? framedSourceLines(text, type) : g.stripLayoutMetadata(text, type).split('\n');
    var at = operation.at.beforeLine;
    if (at < 0 || at > lines.length) return { refusal: SOURCE_LINE_MISSING };
    lines.splice.apply(lines, [at, 0].concat(operation.lines));
    return linesWithStoredLayout(text, type, lines, bundle);
  }

  // The lines from `range.start` to `range.end` of the framed document replaced by `lines`; a range
  // that ends before it starts is empty, and its lines go before `range.start`.
  function rewriteSourceReplaceLines(text, type, operation, bundle) {
    var lines = framedSourceLines(text, type);
    var start = operation.range.start;
    if (!isLineIndexOf(lines, start)) return { refusal: SOURCE_LINE_MISSING };
    lines.splice.apply(lines, [start, Math.max(0, operation.range.end - start + 1)].concat(operation.lines));
    return linesWithStoredLayout(text, type, lines, bundle);
  }

  function rewriteSourceRemoveLines(text, type, operation, bundle) {
    return rewriteSourceReplaceLines(text, type, { range: operation.range, lines: [] }, bundle);
  }

  // The panels' Move buttons exchange a row with its neighbour row, and the lines between the two
  // (blank lines, a layout directive) stay where they are, which a move before a line cannot say.
  function rewriteSourceMoveLines(text, type, operation, bundle) {
    var lines = framedSourceLines(text, type);
    if (!isLineIndexOf(lines, operation.line) || !isLineIndexOf(lines, operation.swapWith)) return { refusal: SOURCE_LINE_MISSING };
    var moved = lines[operation.line];
    lines[operation.line] = lines[operation.swapWith];
    lines[operation.swapWith] = moved;
    return linesWithStoredLayout(text, type, lines, bundle);
  }

  // The whole declaration of the element `ref`, a `{ … }` block too, replaced by `text`; the element
  // shows selected in the drawing the change makes.
  function rewriteSourceReplaceDeclaration(text, type, operation, bundle) {
    var g = textGrammar;
    return {
      text: g.replaceBlockByMatch(text, type, function (line) {
        return g.declarationIdForLine(line, type, bundle) === operation.ref;
      }, operation.text, bundle),
      select: { id: operation.ref, kind: 'node' },
      message: null
    };
  }

  return {
    rewriteSourceReplace: rewriteSourceReplace,
    rewriteSourceInsertLines: rewriteSourceInsertLines,
    rewriteSourceReplaceLines: rewriteSourceReplaceLines,
    rewriteSourceRemoveLines: rewriteSourceRemoveLines,
    rewriteSourceMoveLines: rewriteSourceMoveLines,
    rewriteSourceReplaceDeclaration: rewriteSourceReplaceDeclaration
  };
});
