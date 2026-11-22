(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./te-schemas.js'), require('./te-read.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.textElements) parts.textElements = factory(parts.textSchemas, parts.textRead);
  }
})(typeof self !== 'undefined' ? self : this, function (schemasPart, readPart) {
  // The element and member rewrites (UML-view editing spec §3.4: element.*, member.*, selection.remove, lifeline.add, and
  // the palette stubs of fragment.add; plan Tasks 12 and 13).
  //
  // Moved from the inline script of _includes/uml-editor.html without a changed statement (plan Task 21, spec
  // §3.6); every function reads only its arguments: the text, the diagram type, the operation, and the bundle.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var diagramSupportsAnchoredNotes = schemasPart.diagramSupportsAnchoredNotes;
  var findElementSchema = schemasPart.findElementSchema;
  var findRelationSchema = schemasPart.findRelationSchema;
  var defaultElementLabelForPlacement = schemasPart.defaultElementLabelForPlacement;
  var unquoteId = readPart.unquoteId;
  var sequenceSourceWithScaffold = readPart.sequenceSourceWithScaffold;
  var sourceWithScaffold = readPart.sourceWithScaffold;
  var escapeQuoted = readPart.escapeQuoted;
  var formatRelationEndpointId = readPart.formatRelationEndpointId;
  var findInsertPointForDeclaration = readPart.findInsertPointForDeclaration;
  var clearSequenceMessageLayoutMetadata = readPart.clearSequenceMessageLayoutMetadata;
  var buildCrcCardSource = readPart.buildCrcCardSource;
  var parseMemberLine = readPart.parseMemberLine;
  var buildClassLine = readPart.buildClassLine;
  var parseSequenceHeadText = readPart.parseSequenceHeadText;
  var textGrammar = readPart.textGrammar;

  // Today's commands that place something give the document its @startuml frame before they change
  // it, and an undo returns to the framed document (spec §3.6, requirement 1).
  function framedDocument(text, type) {
    return type === 'sequence' ? sequenceSourceWithScaffold(text) : sourceWithScaffold(text);
  }

  // The newest relation line of `text`, which today's commands select once a line they added is drawn.
  function newestRelationSelection(text, type, bundle) {
    var indices = textGrammar.relationLineIndices(text, type, bundle);
    return indices.length ? { sourceLine: indices[indices.length - 1], kind: 'route' } : undefined;
  }

  // The component document with a port or an interface declared inside component `componentId`'s
  // body, or as it was when that component has no declaration.
  function componentWithPort(text, componentId, spec, portId, label, bundle) {
    var line = textGrammar.getDeclarationLine(text, 'component', componentId, bundle);
    if (!line) return text;
    return textGrammar.replaceBlockByMatch(text, 'component', function (candidate) {
      return textGrammar.declarationIdForLine(candidate, 'component', bundle) === componentId;
    }, textGrammar.componentDeclarationWithPort(line, spec, portId, label, bundle), bundle);
  }

  // The deployment document with a component or an artifact declared inside node `nodeId`'s braces,
  // or as it was when that node has no declaration.
  function deploymentWithChild(text, nodeId, spec, childId, bundle) {
    var line = textGrammar.getDeclarationLine(text, 'deployment', nodeId, bundle);
    if (!line) return text;
    var body = textGrammar.parseBraceBody(line, bundle);
    var childLine = (spec.id === 'artifact' ? 'artifact ' : 'component ') + childId;
    var newLine = textGrammar.setBraceBody(line, (body.trim() ? body.trim() + '\n' : '') + childLine, true, bundle);
    return textGrammar.replaceBlockByMatch(text, 'deployment', function (candidate) {
      return textGrammar.declarationIdForLine(candidate, 'deployment', bundle) === nodeId;
    }, newLine, bundle);
  }

  // element.add of a tool placed at the fact `at` (or for some tools wherever their kind goes) in
  // the framed document `prepared`; `into` names the component or node it goes inside.
  function placedElementAdd(prepared, type, spec, operation, bundle) {
    var g = textGrammar;
    function placed(text, select, message) {
      return { text: text, select: select, message: message || null, prepared: prepared };
    }
    var id = operation.name || g.generateUniqueId(prepared, type, spec.base, bundle);
    var opts = { id: id, label: defaultElementLabelForPlacement(type, spec, id), position: operation.facts.at };
    // A git graph's branch or commit is the row the model panel's buttons add. Today's commit command
    // selects its commit after the drawing, so the command selects it (`ids`), and it shows selected
    // from the next drawing on.
    if (type === 'gitgraph' && spec.gitBranch) {
      var branch = g.addGitgraphBranchToSource(prepared, bundle);
      return placed(branch.text, undefined, 'Added branch "' + branch.id + '".');
    }
    if (type === 'gitgraph' && spec.gitCommit) {
      var commit = g.addGitgraphCommitToSource(prepared, bundle);
      return placed(commit.text, { ids: [commit.id], kind: 'node' }, 'Added commit "' + commit.id + '" to ' + commit.branch + '.');
    }
    if (type === 'folder-tree' && spec.folderTreeKind) {
      return placed(g.appendRawLine(prepared, type, g.buildElementLine(spec, id, opts, type), bundle), undefined);
    }
    // Composite state — wrap a sub-state inside `{ }`.
    if (type === 'state' && spec.isComposite) {
      var subId = g.generateUniqueId(prepared, type, 'Sub', bundle);
      return placed(g.appendRawLine(prepared, type, 'state ' + id + ' { state ' + subId + ' }', bundle), { id: id, kind: 'node' });
    }
    // Activity decisions: insert if/else block stub.
    if (type === 'activity' && spec.activityDecision) {
      var stub = ['if "Condition?" then', '  --> [yes] "ThenAction"', 'else', '  --> [no] "ElseAction"', 'endif'].join('\n');
      return placed(g.appendRawLine(prepared, type, stub, bundle), undefined);
    }
    if (type === 'activity' && spec.activityFork) {
      var fstub = ['fork', '  --> "Branch A"', '  --> "Branch B"', 'endfork'].join('\n');
      return placed(g.appendRawLine(prepared, type, fstub, bundle), undefined);
    }
    if (type === 'activity' && spec.activityLane) {
      var laneId = g.generateUniqueId(prepared, type, 'Lane', bundle);
      return placed(g.appendRawLine(prepared, type, '|' + laneId + '|', bundle), undefined);
    }
    // State pseudostate placeholders.
    if (type === 'state' && spec.pseudo === 'initial') {
      var initialText = g.appendRawLine(prepared, type, '[*] --> ' + g.generateUniqueId(prepared, type, 'New', bundle), bundle);
      return placed(initialText, newestRelationSelection(initialText, type, bundle),
        'Added an initial transition. Use Target endpoint in Properties to rewire it to an existing state.');
    }
    if (type === 'state' && spec.pseudo === 'final') {
      var finalText = g.appendRawLine(prepared, type, g.generateUniqueId(prepared, type, 'Last', bundle) + ' --> [*]', bundle);
      return placed(finalText, newestRelationSelection(finalText, type, bundle),
        'Added a final transition. Use Source endpoint in Properties to rewire it from an existing state.');
    }
    if (type === 'activity' && spec.activityPseudo) {
      var actId = g.generateUniqueId(prepared, type, 'Step', bundle);
      var started = g.appendRawLine(prepared, type, '(*) --> "' + actId + '"', bundle);
      return placed(g.appendRawLine(started, type, '"' + actId + '" --> (*)', bundle), { id: actId, kind: 'node' });
    }
    if (type === 'activity' && spec.activityAction) {
      var existing = g.collectModelElements(prepared, type, bundle).length;
      var stub2;
      if (existing === 0) stub2 = '(*) --> "' + escapeQuoted(opts.label) + '"';
      else {
        var prev = g.collectModelElements(prepared, type, bundle);
        var prevId = prev[prev.length - 1].id;
        stub2 = '"' + escapeQuoted(prevId) + '" --> "' + escapeQuoted(opts.label) + '"';
      }
      return placed(g.appendRawLine(prepared, type, stub2, bundle), { id: opts.label, kind: 'node' });
    }
    // Notes / ports get sensible defaults.
    if (spec.isNote) opts.label = 'New note text';
    if (spec.isPort) opts.label = spec.portKind === 'portin' ? 'in' : 'out';
    if (spec.isInterface) opts.label = spec.interfaceKind === 'provide' ? 'P_iface' : 'R_iface';
    // Ports / interfaces dropped onto a component go INSIDE that component's
    // `{ }` block — they live there in ArchUML and the renderer lays them out
    // on the component border.
    if (type === 'component' && (spec.isPort || spec.isInterface) && operation.into) {
      return placed(componentWithPort(prepared, operation.into, spec, id, opts.label, bundle), { id: operation.into, kind: 'node' });
    }
    if (type === 'deployment' && (spec.id === 'component' || spec.id === 'artifact') && operation.into) {
      return placed(deploymentWithChild(prepared, operation.into, spec, id, bundle), { id: operation.into, kind: 'node' });
    }
    return placed(g.addElementToSource(prepared, type, spec, opts, bundle), { id: id, kind: 'node' });
  }

  // element.add attached to the element `anchor`: a sequence control line or note on a lifeline, a
  // note anchored to an element, or a new element drawn from the extend handle of `anchor` (its line
  // is added next). The text gets no @startuml frame first, and only a note is selected.
  function anchoredElementAdd(text, type, spec, operation, bundle) {
    var g = textGrammar;
    var anchor = operation.anchor;
    if (type === 'sequence' && spec.sequenceControl) {
      return { text: g.appendRawLine(text, type, spec.sequenceControl + ' ' + anchor, bundle), select: { id: anchor, kind: 'node' },
        message: 'Inserted ' + spec.sequenceControl + ' for "' + anchor + '".' };
    }
    if (type === 'sequence' && spec.sequenceNote) {
      return { text: g.appendRawLine(text, type, 'note ' + spec.sequenceNote + ' of ' + anchor + ': New note', bundle), select: { id: anchor, kind: 'node' },
        message: 'Inserted a note for "' + anchor + '".' };
    }
    if (diagramSupportsAnchoredNotes(type) && spec.isNote) {
      var noted = g.appendRawLine(text, type, 'note right of ' + anchor + ': New note', bundle);
      var lines = g.stripLayoutMetadata(noted, type).split('\n');
      var note;
      for (var i = lines.length - 1; i >= 0; i--) {
        if (/^note\s+(left|right|top|bottom|over)\b/i.test(lines[i].trim())) {
          note = { id: 'note:' + i, kind: 'node' };
          break;
        }
      }
      return { text: noted, select: note, message: 'Attached a note to "' + anchor + '".' };
    }
    var id = operation.name || g.generateUniqueId(text, type, spec.base, bundle);
    var opts = { id: id, label: defaultElementLabelForPlacement(type, spec, id), position: operation.facts.at };
    return { text: g.addElementToSource(text, type, spec, opts, bundle), select: undefined, message: null };
  }

  // The class diagram's starter hierarchy: a class that realizes an interface.
  function classStarter(text, bundle) {
    var g = textGrammar;
    var source = sourceWithScaffold(text);
    var classSchema = findElementSchema('class', 'class');
    var interfaceSchema = findElementSchema('class', 'interface');
    var classId = g.generateUniqueId(source, 'class', 'Class', bundle);
    source = g.addElementToSource(source, 'class', classSchema, { id: classId, label: classId, position: { x: 90, y: 120 } }, bundle);
    var ifaceId = g.generateUniqueId(source, 'class', 'IFace', bundle);
    source = g.addElementToSource(source, 'class', interfaceSchema, { id: ifaceId, label: ifaceId, position: { x: 260, y: 80 } }, bundle);
    source = g.addRelationToSource(source, 'class', findRelationSchema('class', 'real'), classId, ifaceId, undefined, bundle);
    return { text: source, select: { id: classId, kind: 'node' }, message: 'Started a class diagram with a class, an interface, and a realization.' };
  }

  // The state machine's starter transition: initial, Idle, Done, and final.
  function stateStarter(text, bundle) {
    var g = textGrammar;
    var source = sourceWithScaffold(text);
    source = g.appendRawLine(source, 'state', '[*] --> Idle', bundle);
    source = g.appendRawLine(source, 'state', 'Idle --> Done : success', bundle);
    source = g.appendRawLine(source, 'state', 'Done --> [*]', bundle);
    return { text: source, select: { id: 'Idle', kind: 'node' }, message: 'Started a state machine with initial, Idle, Done, and final states.' };
  }

  // element.add: `tool` names the palette tool (or 'starter', the starter of a class diagram or a
  // state machine), `name` the new element's identifier (null: a fresh one from the tool), `into` the
  // component or node it goes inside, `anchor` the element it attaches to, `placed` whether the
  // learner chose the place, and the fact `at` that place.
  function rewriteElementAdd(text, type, operation, bundle) {
    if (operation.tool === 'starter') return type === 'state' ? stateStarter(text, bundle) : classStarter(text, bundle);
    var spec = findElementSchema(type, operation.tool);
    if (operation.anchor) return anchoredElementAdd(text, type, spec, operation, bundle);
    return placedElementAdd(framedDocument(text, type), type, spec, operation, bundle);
  }

  // lifeline.add: an actor or a participant (`tool`) after the last lifeline, or with tool 'starter'
  // the starter exchange: an actor, a participant, and a request between them.
  function rewriteLifelineAdd(text, type, operation, bundle) {
    var g = textGrammar;
    var source = sequenceSourceWithScaffold(text);
    if (operation.tool === 'starter') {
      var actorSchema = findElementSchema('sequence', 'actor');
      var participantSchema = findElementSchema('sequence', 'participant');
      var actorId = g.generateUniqueId(source, 'sequence', actorSchema.base, bundle);
      source = g.addElementToSource(source, 'sequence', actorSchema, { id: actorId, label: 'User' }, bundle);
      var participantId = g.generateUniqueId(source, 'sequence', participantSchema.base, bundle);
      source = g.addElementToSource(source, 'sequence', participantSchema, { id: participantId, label: 'Service' }, bundle);
      var sync = findRelationSchema('sequence', 'sync');
      source = g.addRelationToSource(source, 'sequence', sync, actorId, participantId, { label: 'request()' }, bundle);
      return { text: source, select: { id: participantId, kind: 'node' }, message: 'Started a sequence with an actor, a participant, and a request message.' };
    }
    var schema = findElementSchema('sequence', operation.tool);
    var id = operation.name || g.generateUniqueId(source, 'sequence', schema.base, bundle);
    var label = operation.tool === 'actor' ? 'Actor' : 'Participant';
    return { text: g.addElementToSource(source, 'sequence', schema, { id: id, label: label }, bundle), select: { id: id, kind: 'node' },
      message: 'Added ' + schema.label + ' "' + id + '".' };
  }

  // fragment.add with `at`: a stub of the `operator` fragment around a message between the first
  // two lifelines. Today's palette puts it at the end of the document whatever the height of the
  // drop, so `at` is that end; the stub goes before the framed document's last @enduml.
  function rewriteFragmentAdd(text, type, operation, bundle) {
    var prepared = sequenceSourceWithScaffold(text);
    var pair = textGrammar.sequenceDefaultPair(prepared, bundle);
    var blocks = {
      alt: ['alt [condition]', '  ' + pair.source + ' -> ' + pair.target + ': messageA', 'else [otherwise]', '  ' + pair.source + ' -> ' + pair.target + ': messageB', 'end'],
      opt: ['opt [condition]', '  ' + pair.source + ' -> ' + pair.target + ': optionalMsg', 'end'],
      loop: ['loop [while condition]', '  ' + pair.source + ' -> ' + pair.target + ': repeatedMsg', 'end'],
      par: ['par [parallel work]', '  ' + pair.source + ' -> ' + pair.target + ': branchA', 'else [other work]', '  ' + pair.target + ' -> ' + pair.source + ': branchB', 'end'],
      break: ['break [condition]', '  ' + pair.source + ' -> ' + pair.target + ': abortMsg', 'end'],
      critical: ['critical [atomic section]', '  ' + pair.source + ' -> ' + pair.target + ': protectedCall()', 'end'],
      ref: ['ref [external interaction]', '  ' + pair.source + ' -> ' + pair.target + ': referencedStep()', 'end'],
      neg: ['neg [invalid trace]', '  ' + pair.source + ' -> ' + pair.target + ': forbiddenMessage()', 'end']
    };
    var lines = blocks[operation.operator] || [];
    var after = prepared;
    lines.forEach(function (l) { after = textGrammar.appendRawLine(after, type, l, bundle); });
    return { text: after, select: undefined, message: null, prepared: prepared };
  }

  // Why element.duplicate copied nothing.
  var NOTHING_TO_DUPLICATE = { code: 'duplicate/no-declaration', summary: 'No declaration to copy', message: 'Could not locate the selected declaration to duplicate.' };

  // Duplicate on one element: the copy is named ‹id›_copy, and it is placed `offset` from its
  // original only when the original holds a position.
  function duplicateOneElement(text, type, operation, bundle) {
    var g = textGrammar;
    var id = operation.refs[0];
    var line = g.getDeclarationLine(text, type, id, bundle);
    if (!line) return { refusal: NOTHING_TO_DUPLICATE };
    var newId = g.generateUniqueId(text, type, id + '_copy', bundle);
    var newLine = g.cloneDeclarationForDuplicate(text, type, line, id, newId, bundle);
    var positions = g.readLayoutPositions(text, type, bundle);
    if (positions[id]) positions[newId] = { x: positions[id].x + operation.offset.x, y: positions[id].y + operation.offset.y };
    var routes = g.readLayoutRoutes(text, bundle);
    var clean = g.stripLayoutMetadata(text, type);
    var lines = clean.split('\n');
    var insertAt = findInsertPointForDeclaration(lines);
    return {
      text: g.rewriteSourceLines(text, type, [{ start: insertAt, end: insertAt - 1, replacement: newLine }], positions, routes, bundle),
      select: { id: newId, kind: 'node' },
      message: null
    };
  }

  // Duplicate on the selection: each copy is numbered, placed `offset` from where its original is
  // stored or else drawn (the fact `positions`), and an element that cannot be copied is skipped.
  // The copies become the selection.
  function duplicateSelection(text, type, operation, bundle) {
    var g = textGrammar;
    var current = text;
    // Re-read fresh on every loop so generateUniqueId reflects newly
    // inserted ids — otherwise duplicating two elements in one shot could
    // collide on the same generated suffix.
    var newIds = [];
    operation.refs.forEach(function (origId) {
      var positions = g.readLayoutPositions(current, type, bundle);
      var routes = g.readLayoutRoutes(current, bundle);
      var lines = g.stripLayoutMetadata(current, type).split('\n');
      var declIdx = -1;
      for (var i = 0; i < lines.length; i++) {
        if (g.declarationIdForLine(lines[i], type, bundle) === origId) {
          declIdx = i;
          break;
        }
      }
      if (declIdx === -1) return; // declaration not found (pseudostate, etc.)
      var newId = g.generateUniqueId(current, type, origId, bundle);
      var declaration = g.getDeclarationLine(current, type, origId, bundle);
      var renamed = g.cloneDeclarationForDuplicate(current, type, declaration, origId, newId, bundle);
      if (type === 'crc') {
        var duplicateCard = g.crcCardForId(current, origId, bundle);
        if (!duplicateCard) return;
        duplicateCard.id = newId;
        renamed = buildCrcCardSource(duplicateCard);
      }
      if (renamed === declaration) return;
      var insertAt = findInsertPointForDeclaration(lines);
      // Position: prefer explicit @pos from source; fall back to the
      // rendered hitbox bbox for auto-laid-out elements.
      var basePos = positions[origId] || operation.facts.positions[origId];
      if (basePos) {
        positions[newId] = { x: basePos.x + operation.offset.x, y: basePos.y + operation.offset.y };
      }
      current = g.rewriteSourceLines(current, type, [{ start: insertAt, end: insertAt - 1, replacement: renamed }], positions, routes, bundle);
      newIds.push(newId);
    });
    if (!newIds.length) return { refusal: NOTHING_TO_DUPLICATE };
    return {
      text: current,
      select: { ids: newIds, kind: 'node' },
      message: 'Duplicated ' + newIds.length + ' element' + (newIds.length === 1 ? '' : 's') + '.'
    };
  }

  // element.duplicate: a copy of each element of `refs` under a fresh identifier, declared at the
  // end. `scope` says whether Duplicate ran on one element ('element', from its context menu) or on
  // the selection ('selection'), which today place and name their copies differently.
  function rewriteElementDuplicate(text, type, operation, bundle) {
    return operation.scope === 'element'
      ? duplicateOneElement(text, type, operation, bundle)
      : duplicateSelection(text, type, operation, bundle);
  }

  // Refusals of a rename or an update. Where today's command changed nothing and said nothing (a name
  // left as it was, nothing declared to rename), the refusal has no message either.
  var NOTHING_TO_RENAME = { code: 'rename/nothing', summary: 'Nothing to rename', message: null };
  var NOTHING_TO_UPDATE = { code: 'update/nothing', summary: 'Nothing to change', message: null };
  // An operation whose `part` or `changes` names nothing the text adapter can apply: no classic
  // command builds one, so it comes from another surface or a replay (spec §3.4: apply decides).
  var UNKNOWN_RENAME = { code: 'rename/part', summary: 'Rename not available', message: 'The editor cannot make this rename.' };
  var UNKNOWN_UPDATE = { code: 'update/changes', summary: 'Change not available', message: 'The editor cannot make this change.' };
  function identifierRefusal(message) {
    return { refusal: { code: 'identifier/conflict', summary: 'Identifier not available', message: message } };
  }

  // A change that leaves `id` selected in the drawing it makes.
  function withSelected(text, id) {
    return { text: text, select: { id: id, kind: 'node' }, message: null };
  }

  // element.rename, part 'identifier': `text` is the element's new identifier. A component port keeps
  // its component and takes the new alias; a state or a deployment element that only transitions or
  // links name is renamed where it is named; an activity action is renamed as an action.
  function identifierRename(text, type, operation, bundle) {
    var g = textGrammar;
    var oldId = operation.ref;
    var newId = operation.text;
    if (!newId || newId === oldId) return { refusal: NOTHING_TO_RENAME };
    var taken = g.existingIds(text, type, bundle);
    var conflict = g.identifierConflict(text, type, newId, bundle);
    if (conflict) return identifierRefusal(conflict);
    var sourceText = text;
    const port = g.componentPortForId(sourceText, type, oldId, bundle);
    if (port) {
      const alias = newId.indexOf(port.owner + '.') === 0 ? newId.slice(port.owner.length + 1) : newId;
      if (!alias || /[\s.]/.test(alias)) {
        return { refusal: { code: 'identifier/port-alias', summary: 'A port keeps its component',
          message: 'Keep the port in "' + port.owner + '" and use a unique port identifier.' } };
      }
      newId = port.owner + '.' + alias;
      if (taken[newId]) return identifierRefusal('"' + newId + '" is already used. Pick a different identifier.');
      const oldAlias = port.body.ports[port.index].alias;
      port.body.ports[port.index].alias = alias;
      sourceText = g.replaceBlockByMatch(sourceText, type, function (line) { return g.declarationIdForLine(line, type, bundle) === port.owner; }, g.setComponentBody(port.declaration, port.body, bundle), bundle);
      sourceText = g.renameReferencesInRelations(sourceText, type, oldId, newId, text, bundle);
      // Connectors may also name the port by its bare alias (`b_db --> db_in`).
      return withSelected(g.renameReferencesInRelations(sourceText, type, oldAlias, alias, text, bundle), newId);
    }
    // Re-emit declaration with the new id, then rewrite references.
    var line = g.getDeclarationLine(sourceText, type, oldId, bundle);
    if (line == null) {
      if (type === 'activity') return actionRename(text, type, operation, bundle);
      if ((type !== 'state' && type !== 'deployment') || oldId === '[*]') return { refusal: NOTHING_TO_RENAME };
      return withSelected(g.renameReferencesInRelations(sourceText, type, oldId, newId, text, bundle), newId);
    }
    var renamed = g.renameDeclarationIdentifier(line, type, oldId, newId, bundle);
    if (renamed === line) return { refusal: NOTHING_TO_RENAME };
    sourceText = g.replaceBlockByMatch(sourceText, type, function (l) { return g.declarationIdForLine(l, type, bundle) === oldId; }, renamed, bundle);
    sourceText = g.renameReferencesInRelations(sourceText, type, oldId, newId, text, bundle);
    return withSelected(sourceText, newId);
  }

  // element.rename, part 'action': `text` is an activity action's new text, which is its identity. The
  // action shows selected from the next drawing on.
  function actionRename(text, type, operation, bundle) {
    var oldId = operation.ref;
    var next = String(operation.text || '').trim();
    if (!next || next === oldId) return { refusal: NOTHING_TO_RENAME };
    var taken = textGrammar.collectModelElements(text, 'activity', bundle).some(function (item) {
      return item && item.id === next && item.id !== oldId;
    });
    if (taken) return identifierRefusal('"' + next + '" is already used. Pick a different action label.');
    return {
      text: textGrammar.renameReferencesInRelations(text, type, oldId, next, text, bundle),
      select: { ids: [next], kind: 'node' },
      message: 'Renamed action to "' + next + '".'
    };
  }

  // element.rename, part 'head': `text` is a lifeline's head as typed in place, `identifier: label` or a
  // label alone. The lifeline shows selected from the next drawing on.
  function lifelineHeadRename(text, type, operation, bundle) {
    var g = textGrammar;
    var id = operation.ref;
    var line = g.getDeclarationLine(text, 'sequence', id, bundle);
    if (line == null) return { refusal: NOTHING_TO_RENAME };
    var parsed = parseSequenceHeadText(operation.text, id);
    if (!parsed || !parsed.id || !parsed.label) return { refusal: NOTHING_TO_RENAME };
    var newId = parsed.id;
    var conflict = newId !== id && g.identifierConflict(text, 'sequence', newId, bundle);
    if (conflict) return identifierRefusal(conflict);
    var kind = /^actor\b/i.test(line.trim()) ? 'actor' : 'participant';
    var schema = findElementSchema('sequence', kind);
    if (!schema) return { refusal: NOTHING_TO_RENAME };
    const info = g.parseGenericElement(line, 'sequence', bundle);
    info.label = parsed.label;
    var newLine = g.buildElementLine(schema, newId, info, type);
    var sourceText = g.replaceLineByMatch(text, 'sequence', function (candidate) {
      return g.declarationIdForLine(candidate, 'sequence', bundle) === id;
    }, newLine, bundle);
    if (newId !== id) sourceText = g.renameReferencesInRelations(sourceText, type, id, newId, text, bundle);
    return { text: sourceText, select: { ids: [newId], kind: 'node' }, message: null };
  }

  // element.rename, part 'note': `text` is a note's new text. A block note's body becomes that one
  // line, with the indent of its first line. The note shows selected from the next drawing on.
  function noteTextRename(text, type, operation, bundle) {
    var g = textGrammar;
    var range = g.virtualNoteLineRange(operation.ref, text, type);
    if (!range) return { refusal: NOTHING_TO_RENAME };
    var noteText = String(operation.text || '').trim();
    if (!noteText) return { refusal: NOTHING_TO_RENAME };
    var line = range.lines[range.start];
    if (/:/.test(line)) {
      range.lines[range.start] = line.replace(/:\s*.*$/, ': ' + noteText);
    } else {
      var indent = (range.lines[range.start + 1] || '').match(/^\s*/);
      var bodyIndent = indent ? indent[0] : '  ';
      range.lines.splice(range.start + 1, Math.max(0, range.end - range.start - 1), bodyIndent + noteText);
    }
    return {
      text: g.writePositionsIntoSource(range.lines.join('\n'), type, g.readLayoutPositions(text, type, bundle), g.readLayoutRoutes(text, bundle), bundle),
      select: { ids: ['note:' + range.start], kind: 'node' },
      message: null
    };
  }

  // element.rename, part 'references': the sequence panel has already written a lifeline's line under
  // its new identifier `text`; the messages and notes that name the lifeline follow. This is half of
  // a rename: applied without that line's write before it, the lifeline keeps its old identifier
  // (plan Task 16 may merge the two writes; Task 48 records the part).
  function referencesRename(text, type, operation, bundle) {
    return withSelected(textGrammar.renameReferencesInRelations(text, type, operation.ref, operation.text, text, bundle), operation.text);
  }

  // element.rename: `ref` the element and `text` its new name (spec §3.4). The text adapter also
  // reads `part`, a field beyond the spec's row (plan Task 48 records it), because today's renames
  // read the text differently: an identifier, an action's text, a lifeline's head, a note's text, or
  // the identifier the references take after the sequence panel rebuilt a lifeline's line. Without a
  // part the text is the element's identifier, the rename the spec's row names.
  var RENAMES = {
    identifier: identifierRename,
    action: actionRename,
    head: lifelineHeadRename,
    note: noteTextRename,
    references: referencesRename
  };
  function rewriteElementRename(text, type, operation, bundle) {
    var part = operation.part == null ? 'identifier' : operation.part;
    if (!Object.prototype.hasOwnProperty.call(RENAMES, part)) return { refusal: UNKNOWN_RENAME };
    return RENAMES[part](text, type, operation, bundle);
  }

  // The class `oldId` with its declaration rebuilt from `info` (a class as parseClassDeclaration reads
  // it: `kind`, `isAbstract`, `name`, `declarationLabel`, `stereotype`, `highlight`, `texture`,
  // `rawAfter`, `members`); a new name carries its references along.
  function classRebuilt(text, type, oldId, info, bundle) {
    var g = textGrammar;
    if (info.name !== oldId && g.existingIds(text, type, bundle)[info.name]) {
      return identifierRefusal('"' + info.name + '" is already used. Pick a different identifier.');
    }
    var newLine = buildClassLine(info);
    var newId = info.name;
    var sourceText = g.replaceBlockByMatch(text, type, function (line) {
      return g.declarationIdForLine(line, type, bundle) === oldId;
    }, newLine, bundle);
    if (newId !== oldId && newId) sourceText = g.renameReferencesInRelations(sourceText, type, oldId, newId, text, bundle);
    var preserveId = (newId !== oldId && newId) ? newId : oldId;
    return withSelected(sourceText, preserveId);
  }

  // element.update of a class, from the Properties pane's class form: `changes.classDeclaration` is
  // the class as the form holds it (classRebuilt reads it).
  function classDeclarationUpdate(text, type, operation, bundle) {
    return classRebuilt(text, type, operation.ref, operation.changes.classDeclaration, bundle);
  }

  // element.update of an element other than a class, from its Properties form: `changes.declaration`
  // holds the form's fields (`tool`, the palette tool of its kind; `name`, `label`, `stereotype`,
  // `highlight`, `texture`, `dashed`), and the declaration is rebuilt from them with its `{ … }` body.
  function declarationUpdate(text, type, operation, bundle) {
    var g = textGrammar;
    var oldId = operation.ref;
    var info = operation.changes.declaration;
    var schema = findElementSchema(type, info.tool);
    var newId = (info.name || oldId).trim();
    var label = info.label || newId;
    if (type === 'venn' && schema && schema.keyword === 'set') {
      newId = String(label || newId).trim() || newId;
    }
    var declLine = g.buildElementLine(schema, newId, {
      label: label,
      stereotype: info.stereotype,
      highlight: info.highlight,
      texture: info.texture
    }, type);
    var oldLine = g.getDeclarationLine(text, type, oldId, bundle);
    if (info.dashed && /\bcomponent\b/.test(declLine)) declLine = declLine.replace(/\s+dashed\b/i, '') + ' dashed';
    if (oldLine && /\{/.test(oldLine) && declLine) {
      declLine = g.setBraceBody(declLine, g.parseBraceBody(oldLine, bundle), oldLine.indexOf('\n') !== -1, bundle);
    }
    var sourceText = g.replaceBlockByMatch(text, type, function (line) {
      return g.declarationIdForLine(line, type, bundle) === oldId;
    }, declLine, bundle);
    if (newId !== oldId && newId) sourceText = g.renameReferencesInRelations(sourceText, type, oldId, newId, text, bundle);
    return withSelected(sourceText, newId);
  }

  // element.update of a CRC card: `changes.card` is the card as its form or the in-place editor rebuilt
  // it (`id`, `name`, `responsibilities`, `collaborators`), written in place of the card `ref`.
  function crcCardUpdate(text, type, operation, bundle) {
    return { text: textGrammar.replaceCrcCardInSource(text, operation.ref, operation.changes.card, bundle), select: undefined, message: null };
  }

  // element.update of a use-case system: `changes.membership` puts the use case `member` into the
  // system `ref`'s braces (`included`), or takes it out, its declaration then following the system.
  function systemMembershipUpdate(text, type, operation, bundle) {
    var g = textGrammar;
    var systemId = operation.ref;
    var usecaseId = operation.changes.membership.member;
    var included = operation.changes.membership.included;
    var declaration = g.getDeclarationLine(text, 'usecase', systemId, bundle);
    if (!declaration) return { refusal: NOTHING_TO_UPDATE };
    var hoisted = [];
    var entries = [], entry = '', quoted = false, escaped = false;
    var rawBody = g.parseBraceBody(declaration, bundle);
    for (var i = 0; i < rawBody.length; i++) {
      var ch = rawBody[i];
      if (ch === '"' && !escaped) quoted = !quoted;
      if (!quoted && (ch === ';' || ch === '\n')) { entries.push(entry); entry = ''; }
      else entry += ch;
      escaped = ch === '\\' && !escaped;
    }
    entries.push(entry);
    var body = entries.filter(function (line) {
      var nestedId = g.declarationIdForLine(line, 'usecase', bundle);
      if (nestedId === usecaseId) {
        if (!included) hoisted.push(line.trim());
        return included;
      }
      return unquoteId(line.trim()) !== usecaseId;
    }).filter(function (line) { return line.trim(); });
    var declaredInside = body.some(function (line) { return g.declarationIdForLine(line, 'usecase', bundle) === usecaseId; });
    if (included && !declaredInside) body.push(formatRelationEndpointId(usecaseId));
    var braces = g.declarationBraceRange(declaration, bundle);
    var header = (braces ? declaration.slice(0, braces.start) : declaration).trim();
    var replacement = header + ' {\n' + body.map(function (line) { return '  ' + line.trim(); }).join('\n') + '\n}';
    if (hoisted.length) replacement += '\n' + hoisted.join('\n');
    return withSelected(g.replaceBlockByMatch(text, 'usecase', function (line) {
      return g.declarationIdForLine(line, 'usecase', bundle) === systemId;
    }, replacement, bundle), systemId);
  }

  // element.update: `ref` the element and `changes` what its form changed, as exactly one change whose
  // name says how to read it (the names are beyond spec §3.4's row; plan Task 48 records them): a
  // class's `classDeclaration` or another element's `declaration` as its Properties form holds it, a
  // CRC `card`, or a use-case system's `membership`. A declaration whose `name` differs from `ref`
  // renames the element, its references following, as the form's Name field does today; an adapter
  // that keeps an identifier on later renames (spec §14 D1) must read such an update as a rename.
  var UPDATES = {
    classDeclaration: classDeclarationUpdate,
    declaration: declarationUpdate,
    card: crcCardUpdate,
    membership: systemMembershipUpdate
  };
  function rewriteElementUpdate(text, type, operation, bundle) {
    var named = Object.keys(operation.changes || {});
    if (named.length !== 1 || !Object.prototype.hasOwnProperty.call(UPDATES, named[0])) return { refusal: UNKNOWN_UPDATE };
    return UPDATES[named[0]](text, type, operation, bundle);
  }

  // member.add, member.update, member.remove: the members of the class `owner` are the one list
  // 'members' of its declaration, `index` counts them from 0, and `text` is a member as written in the
  // source. The declaration is read from the document and rebuilt with the change, as the class
  // editing bar and the in-place member editor change it.
  function classWithMemberChange(text, type, operation, bundle, change) {
    var line = textGrammar.getDeclarationLine(text, 'class', operation.owner, bundle);
    if (!line) return { refusal: NOTHING_TO_UPDATE };
    var info = textGrammar.parseClassDeclaration(line, bundle);
    change(info.members);
    return classRebuilt(text, type, operation.owner, info, bundle);
  }
  function rewriteMemberAdd(text, type, operation, bundle) {
    return classWithMemberChange(text, type, operation, bundle, function (members) {
      members.splice(operation.index, 0, parseMemberLine(operation.text));
    });
  }
  function rewriteMemberUpdate(text, type, operation, bundle) {
    return classWithMemberChange(text, type, operation, bundle, function (members) {
      members[operation.index] = parseMemberLine(operation.text);
    });
  }
  function rewriteMemberRemove(text, type, operation, bundle) {
    return classWithMemberChange(text, type, operation, bundle, function (members) {
      members.splice(operation.index, 1);
    });
  }

  // element.remove: the element `ref` goes, with what it owns and every statement that names it.
  function rewriteElementRemove(text, type, operation, bundle) {
    return { text: textGrammar.removeElementFromSource(text, type, operation.ref, bundle), select: undefined, message: null };
  }

  // selection.remove: the selected activation bars (`{ id, startLine, endLine }`, their lines as drawn),
  // connections (relation references `{ routeId, line, candidates }`, `line` the line each resolved to
  // on the drawing, or -1), fragments (by id), and elements (by id) go in one step, in that order, each
  // removal reading the document the one before left. As today, a connection's line indexes the
  // document as the activation bars' removal left it, and a connection whose line is gone from it is
  // kept. Nothing stays selected; the message counts what went and what was kept.
  function rewriteSelectionRemove(text, type, operation, bundle) {
    var g = textGrammar;
    var current = text;
    var activationLineIdxs = [];
    operation.activations.forEach(function (bar) {
      if (bar.startLine != null) activationLineIdxs.push(bar.startLine);
      if (bar.endLine != null) activationLineIdxs.push(bar.endLine);
    });
    if (activationLineIdxs.length) {
      var actPositions = g.readLayoutPositions(current, type, bundle);
      var actRoutes = g.readLayoutRoutes(current, bundle);
      clearSequenceMessageLayoutMetadata(actPositions, actRoutes);
      var actLines = g.stripLayoutMetadata(sequenceSourceWithScaffold(current), type).split('\n');
      activationLineIdxs.sort(function (a, b) { return b - a; }).forEach(function (idx) {
        if (idx >= 0 && idx < actLines.length && /^\s*(de)?activate\b/i.test(actLines[idx])) actLines.splice(idx, 1);
      });
      current = g.writePositionsIntoSource(actLines.join('\n'), 'sequence', actPositions, actRoutes, bundle);
    }
    var lines = g.stripLayoutMetadata(current, type).split('\n');
    var routeIdxs = [];
    var keptRoutes = 0;
    operation.relations.forEach(function (relation) {
      if (relation.line !== -1 && lines[relation.line] != null) routeIdxs.push(relation.line);
      else keptRoutes++;
    });
    // Drop highest-numbered route lines first.
    routeIdxs.sort(function (a, b) { return b - a; });
    routeIdxs.forEach(function (idx) {
      current = g.removeRelationLine(current, type, idx, bundle);
    });
    // Drop fragments wholesale (opener + branches + end + nested content).
    // Sort by source-line descending so earlier indices remain valid.
    if (operation.fragments.length) {
      var fragInfos = operation.fragments.map(function (fid) {
        return g.fragmentInfoForId(fid, current, type, bundle);
      }).filter(Boolean);
      fragInfos.sort(function (a, b) { return b.startIdx - a.startIdx; });
      fragInfos.forEach(function (info) {
        var positions = g.readLayoutPositions(current, type, bundle);
        var routes = g.readLayoutRoutes(current, bundle);
        var fragmentLines = g.stripLayoutMetadata(current, type).split('\n');
        if (info.endIdx === -1) return;
        fragmentLines.splice(info.startIdx, info.endIdx - info.startIdx + 1);
        current = g.writePositionsIntoSource(fragmentLines.join('\n'), 'sequence', positions, routes, bundle);
      });
    }
    // Then drop elements (each call also strips relations referencing the id).
    operation.elements.forEach(function (id) {
      current = g.removeElementFromSource(current, type, id, bundle);
    });
    var selected = operation.activations.length + operation.relations.length + operation.fragments.length + operation.elements.length;
    var deleted = selected - keptRoutes;
    var message = deleted ? 'Deleted ' + deleted + ' item' + (deleted === 1 ? '' : 's') + '.' : '';
    if (keptRoutes) {
      message += (message ? ' ' : '') + (keptRoutes === 1
        ? 'Kept 1 connection that could not be matched to one line of the source.'
        : 'Kept ' + keptRoutes + ' connections that could not be matched to one line of the source.');
    }
    return { text: current, select: null, message: message };
  }

  return {
    newestRelationSelection: newestRelationSelection,
    UNKNOWN_UPDATE: UNKNOWN_UPDATE,
    rewriteElementAdd: rewriteElementAdd,
    rewriteLifelineAdd: rewriteLifelineAdd,
    rewriteFragmentAdd: rewriteFragmentAdd,
    rewriteElementDuplicate: rewriteElementDuplicate,
    rewriteElementRename: rewriteElementRename,
    rewriteElementUpdate: rewriteElementUpdate,
    rewriteMemberAdd: rewriteMemberAdd,
    rewriteMemberUpdate: rewriteMemberUpdate,
    rewriteMemberRemove: rewriteMemberRemove,
    rewriteElementRemove: rewriteElementRemove,
    rewriteSelectionRemove: rewriteSelectionRemove
  };
});
