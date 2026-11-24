(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../de-operations.js'), require('./te-schemas.js'), require('./te-read.js'), require('./te-layout.js'), require('./te-elements.js'), require('./te-relations.js'), require('./te-sequence.js'), require('./te-source.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.text) parts.text = factory(parts.operations, parts.textSchemas, parts.textRead, parts.textLayout, parts.textElements, parts.textRelations, parts.textSequence, parts.textSource);
  }
})(typeof self !== 'undefined' ? self : this, function (operationsPart, schemasPart, readPart, layoutPart, elementsPart, relationsPart, sequencePart, sourcePart) {
  // The text adapter (UML-view editing spec §3.4, §3.6): the edit adapter of the UML editor, which reads and rewrites
  // ArchUML text and hands each change to its host's write. One rewrite per operation, each pure. Its part is
  // `ArchUMLDiagramEditorParts.text`: createTextAdapter, rewrite, readContents, the schemas, and the serializers.
  //
  // Moved from the inline script of _includes/uml-editor.html (plan Task 21, spec §3.6). Three changes go with the
  // move: the verdicts come from de-operations.js, which owns their shape for every adapter; the lookup of an
  // operation's rewrite is the function `rewrite` (the recipe's compute step, spec §3.6), which apply calls; and the
  // schemas and serializers an adapter hands out are built once, here, so the part can hand them out too.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var accepted = operationsPart.accepted;
  var refused = operationsPart.refused;
  var elementSchemasFor = schemasPart.elementSchemasFor;
  var relationSchemasFor = schemasPart.relationSchemasFor;
  var findElementSchema = schemasPart.findElementSchema;
  var findRelationSchema = schemasPart.findRelationSchema;
  var toolsFor = schemasPart.toolsFor;
  var applyLayoutDirective = readPart.applyLayoutDirective;
  var parseMemberLine = readPart.parseMemberLine;
  var buildClassLine = readPart.buildClassLine;
  var textGrammar = readPart.textGrammar;
  var readContents = readPart.readContents;
  var rewriteLayoutSet = layoutPart.rewriteLayoutSet;
  var rewriteLayoutReset = layoutPart.rewriteLayoutReset;
  var rewriteLifelineReorder = layoutPart.rewriteLifelineReorder;
  var rewriteElementAdd = elementsPart.rewriteElementAdd;
  var rewriteLifelineAdd = elementsPart.rewriteLifelineAdd;
  var rewriteFragmentAdd = elementsPart.rewriteFragmentAdd;
  var rewriteElementDuplicate = elementsPart.rewriteElementDuplicate;
  var rewriteElementRename = elementsPart.rewriteElementRename;
  var rewriteElementUpdate = elementsPart.rewriteElementUpdate;
  var rewriteMemberAdd = elementsPart.rewriteMemberAdd;
  var rewriteMemberUpdate = elementsPart.rewriteMemberUpdate;
  var rewriteMemberRemove = elementsPart.rewriteMemberRemove;
  var rewriteElementRemove = elementsPart.rewriteElementRemove;
  var rewriteSelectionRemove = elementsPart.rewriteSelectionRemove;
  var rewriteRelationAdd = relationsPart.rewriteRelationAdd;
  var rewriteRelationUpdate = relationsPart.rewriteRelationUpdate;
  var rewriteRelationRewire = relationsPart.rewriteRelationRewire;
  var rewriteRelationInvert = relationsPart.rewriteRelationInvert;
  var rewriteMessageMove = sequencePart.rewriteMessageMove;
  var rewriteFragmentWrap = sequencePart.rewriteFragmentWrap;
  var rewriteFragmentUpdate = sequencePart.rewriteFragmentUpdate;
  var rewriteFragmentAddBranch = sequencePart.rewriteFragmentAddBranch;
  var rewriteFragmentUnwrap = sequencePart.rewriteFragmentUnwrap;
  var rewriteFragmentMove = sequencePart.rewriteFragmentMove;
  var rewriteActivationSet = sequencePart.rewriteActivationSet;
  var rewriteActivationAdd = sequencePart.rewriteActivationAdd;
  var rewriteSourceReplace = sourcePart.rewriteSourceReplace;
  var rewriteSourceInsertLines = sourcePart.rewriteSourceInsertLines;
  var rewriteSourceReplaceLines = sourcePart.rewriteSourceReplaceLines;
  var rewriteSourceRemoveLines = sourcePart.rewriteSourceRemoveLines;
  var rewriteSourceMoveLines = sourcePart.rewriteSourceMoveLines;
  var rewriteSourceReplaceDeclaration = sourcePart.rewriteSourceReplaceDeclaration;

  // One rewrite per operation of spec §3.4, added stage by stage (plan Tasks 11-16): (text, type,
  // operation, bundle) → { text, select, message, prepared } or { refusal: { code, summary, message } }.
  // `select` is the selection the change leaves: null clears it, undefined leaves it as it is, and
  // `{ ids }` names things the command selects itself after the drawing (the copies of a Duplicate, a
  // git graph's new commit, a renamed action, lifeline head, or note, which show selected from the
  // next drawing on). `prepared` is the document as the rewrite prepared it before its
  // change, when that is not the text it was given; an undo returns to it.
  // The operations only a host surface sends (plan Task 38): the classic surface sends neither, and ArchUML text keeps
  // nesting and branches in its lines, which the UML editor's own gestures and forms edit. Each is refused, unwritten.
  function notSupported(summary, message) {
    return function () { return { refusal: { code: 'not-supported', summary: summary, message: message } }; };
  }

  var REWRITES = {
    'element.reparent': notSupported('Not available in the UML editor',
      'The UML editor cannot put an element into another one here. Change the nesting in the source text.'),
    'fragment.removeBranch': notSupported('Not available in the UML editor',
      'The UML editor cannot remove a branch here. Delete the branch\'s else line in the source text.'),
    'layout.setMode': function (text, type, operation) {
      return { text: applyLayoutDirective(text, operation.mode), select: undefined, message: null };
    },
    'layout.set': rewriteLayoutSet,
    'layout.reset': rewriteLayoutReset,
    'lifeline.reorder': rewriteLifelineReorder,
    'element.add': rewriteElementAdd,
    'lifeline.add': rewriteLifelineAdd,
    // A palette stub at `at`, or a wrap of message lines.
    'fragment.add': function (text, type, operation, bundle) {
      return operation.wrap ? rewriteFragmentWrap(text, type, operation, bundle) : rewriteFragmentAdd(text, type, operation, bundle);
    },
    'element.duplicate': rewriteElementDuplicate,
    'element.rename': rewriteElementRename,
    'element.update': rewriteElementUpdate,
    'member.add': rewriteMemberAdd,
    'member.update': rewriteMemberUpdate,
    'member.remove': rewriteMemberRemove,
    'element.remove': rewriteElementRemove,
    'selection.remove': rewriteSelectionRemove,
    'relation.add': rewriteRelationAdd,
    'relation.update': rewriteRelationUpdate,
    'relation.rewire': rewriteRelationRewire,
    'relation.invert': rewriteRelationInvert,
    'message.move': rewriteMessageMove,
    'fragment.update': rewriteFragmentUpdate,
    'fragment.addBranch': rewriteFragmentAddBranch,
    'fragment.unwrap': rewriteFragmentUnwrap,
    'fragment.move': rewriteFragmentMove,
    'activation.add': rewriteActivationAdd,
    'activation.set': rewriteActivationSet,
    'source.replace': rewriteSourceReplace,
    'source.insertLines': rewriteSourceInsertLines,
    'source.replaceLines': rewriteSourceReplaceLines,
    'source.removeLines': rewriteSourceRemoveLines,
    'source.moveLines': rewriteSourceMoveLines,
    'source.replaceDeclaration': rewriteSourceReplaceDeclaration
  };

  /**
   * The new text of the document `text` of diagram type `type` after `operation`, computed by the operation's rewrite:
   * `{ text, select, message, prepared }`, or `{ refusal: { code, summary, message } }`. Pure: it reads only its
   * arguments and the bundle's parsers. Throws for an operation the text adapter has no rewrite for.
   */
  function rewrite(text, type, operation, bundle) {
    if (!Object.prototype.hasOwnProperty.call(REWRITES, operation.op)) {
      throw new Error('The text adapter has no rewrite for ' + operation.op + '.');
    }
    return REWRITES[operation.op](text, type, operation, bundle);
  }

  // The element and relation schemas, by diagram type.
  var SCHEMAS = {
    elementsFor: elementSchemasFor,
    relationsFor: relationSchemasFor,
    findElement: findElementSchema,
    findRelation: findRelationSchema
  };

  /** The body parse and serialize functions the Properties pane builds its values with, over the parsers of `bundle`. */
  function serializersFor(bundle) {
    return {
      parseBraceBody: function (line) { return textGrammar.parseBraceBody(line, bundle); },
      setBraceBody: function (line, body, multiline) { return textGrammar.setBraceBody(line, body, multiline, bundle); },
      bodyStatementRanges: function (body, groupNotes) { return textGrammar.bodyStatementRanges(body, groupNotes, bundle); },
      splitBodyStatements: function (body) { return textGrammar.splitBodyStatements(body, bundle); },
      parseComponentBody: function (body) { return textGrammar.parseComponentBody(body, bundle); },
      setComponentBody: function (declaration, parsed) { return textGrammar.setComponentBody(declaration, parsed, bundle); },
      parseGenericElement: function (line, type) { return textGrammar.parseGenericElement(line, type, bundle); },
      parseClassDeclaration: function (line) { return textGrammar.parseClassDeclaration(line, bundle); },
      buildClassLine: buildClassLine,
      parseMemberLine: parseMemberLine
    };
  }

  /**
   * The text adapter (spec §3.4): `read()` gives the document, `type()` its diagram type, `bundle` the
   * bundle's parsers, and `write(text, info)` makes the change one undo step and draws it (or, when
   * the operation's `undo.joinsPrevious` is true, part of the step before it). `apply`
   * writes the text the operation's rewrite computes, exactly once, or refuses and writes nothing.
   */
  function createTextAdapter(options) {
    var bundle = options.bundle;
    return {
      // A new reading of the document as it is now; each caller reads it when it needs it.
      contents: function () { return readContents(options.read(), options.type(), bundle); },
      tools: function () { return toolsFor(options.type()); },
      schemas: SCHEMAS,
      serializers: serializersFor(bundle),
      // Advice only, never relied on by apply: the text adapter refuses nothing a gesture starts with (spec §3.6).
      can: function () { return accepted(null, null); },
      // No advice: as in the classic editor, a gesture marks no target as possible or not.
      targets: function () { return null; },
      apply: function (operation) {
        var before = options.read();
        var result = rewrite(before, options.type(), operation, options.bundle);
        if (result.refusal) {
          return refused(result.refusal.code, result.refusal.summary, result.refusal.message, null);
        }
        var undoTo = result.prepared === undefined ? before : result.prepared;
        options.write(result.text, {
          undoKey: operation.undo.key,
          joinsPrevious: operation.undo.joinsPrevious === true,
          before: undoTo,
          select: result.select,
          operation: operation
        });
        return accepted(result.select, result.message);
      }
    };
  }

  return {
    createTextAdapter: createTextAdapter,
    rewrite: rewrite,
    readContents: readContents,
    schemas: SCHEMAS,
    // (bundle) → the serializers over that bundle's parsers, as an adapter's `serializers`.
    serializers: serializersFor
  };
});
