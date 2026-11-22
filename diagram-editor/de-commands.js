(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./de-geometry.js'), require('./de-scene.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.commands) parts.commands = factory(parts.geometry, parts.scene);
  }
})(typeof self !== 'undefined' ? self : this, function (geometry, scene) {
  'use strict';

  // The commands of a session (UML-view editing spec §2.1, §2.2, §3.4; plan Task 23): each builds one operation from
  // references and scene facts, has the adapter apply it, puts the selection where the change is, and reports the
  // verdict. Commands know no pointer and no key.
  //
  // createCommands is what every host and surface gets: the commands of spec §2.4 over an adapter and a host. The
  // classic commands (createClassicCommands) are the UML editor's own commands as they were in the session; they
  // build their operations with buildOperationOf and report their verdicts as they always have.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var classicFragmentRange = scene.classicFragmentRange;
  var containsBox = geometry.containsBox;
  var containsPoint = geometry.containsPoint;
  var cssAttrEscape = scene.cssAttrEscape;
  var freePlaceRightOf = geometry.freePlaceRightOf;
  var lineMentionsId = scene.lineMentionsId;
  var readScene = scene.readScene;

  // An operation of spec §3.4 as a command builds it: its name, the revision of the document `adapter` reads now,
  // its fields, the scene facts its row names, and its undo coalescing key (or null).
  function buildOperationOf(adapter, op, fields, facts, undoKey) {
    return Object.assign({ op: op, revision: adapter.contents().revision }, fields, { facts: facts, undo: { key: undoKey } });
  }
  // The operation, made part of the undo step before it instead of a step of its own.
  function joiningPreviousStep(operation) {
    operation.undo.joinsPrevious = true;
    return operation;
  }

  // The kinds of a selection reference that are not elements (spec §3.4, selection.remove).
  var NOT_ELEMENTS = ['route', 'fragment', 'activation'];

  /**
   * The commands of a session over `adapter` and `host` (spec §2.1, §2.4). Each builds one operation of spec §3.4
   * from the document as `adapter.contents()` reads it when the command runs, has the adapter apply it, and reports
   * the verdict (`run`): a verdict with a message goes to `host.announce(message, { verdict })`, a verdict without one
   * is not announced (a shared action of the C4 host announces itself), and an accepted verdict's `select` is what
   * `restoreForNextSync()` gives the next sync. `remove` and `duplicate` take the selection set `selection` when they
   * are given no references. `can` and `targetsFor` are the adapter's advice, asked once per gesture and per request;
   * `contents` and `apply` are the reading and the unreported apply, for a gesture that reports by itself.
   */
  function createCommands(options) {
    var adapter = options.adapter;
    var host = options.host;
    var selection = options.selection;
    var restore = null;

    function operation(op, fields) {
      return buildOperationOf(adapter, op, fields, {}, null);
    }
    function report(verdict) {
      if (verdict.ok && verdict.select) restore = verdict.select;
      if (verdict.message) host.announce(verdict.message, { verdict: verdict });
      return verdict;
    }
    // Applies `op` and reports its verdict; a promise, since an adapter may ask a form or a confirmation first.
    function run(op) {
      return Promise.resolve(adapter.apply(op)).then(report);
    }
    function referencesOr(refs) {
      return refs || (selection ? selection.all() : []);
    }
    function isRelationReference(ref) {
      return ref.routeId !== undefined || ref.line !== undefined;
    }
    function ofKind(refs, kind) {
      return refs.filter(function (ref) { return ref.kind === kind; });
    }

    return {
      contents: function () { return adapter.contents(); },
      can: function (op) { return adapter.can(op); },
      apply: function (op) { return adapter.apply(op); },
      run: run,
      // The adapter's advice for a gesture with one open end (spec §3.4, targets), or null for none.
      targetsFor: function (request) {
        return adapter.targets(Object.assign({ revision: adapter.contents().revision }, request)) || null;
      },
      // The selection the next sync brings back, once: the last accepted verdict's `select`, or null.
      restoreForNextSync: function () {
        var next = restore;
        restore = null;
        return next;
      },
      add: function (tool, at) {
        return run(operation('element.add', { tool: tool, name: null, into: null, anchor: null, placed: at ? 'dropped' : 'automatic', at: at || null }));
      },
      rename: function (ref, text) {
        return run(operation('element.rename', { ref: ref, text: text }));
      },
      update: function (ref, changes) {
        return run(operation(isRelationReference(ref) ? 'relation.update' : 'element.update', { ref: ref, changes: changes }));
      },
      // A route of the selection is named by its route id; the adapter resolves it against its document.
      remove: function (refs) {
        var all = referencesOr(refs);
        return run(operation('selection.remove', {
          elements: all.filter(function (ref) { return NOT_ELEMENTS.indexOf(ref.kind) === -1; }).map(function (ref) { return ref.id; }),
          relations: ofKind(all, 'route').map(function (ref) { return { routeId: ref.id }; }),
          fragments: ofKind(all, 'fragment').map(function (ref) { return ref.id; }),
          activations: ofKind(all, 'activation').map(function (ref) { return { id: ref.id }; })
        }));
      },
      duplicate: function (refs, offset) {
        return run(operation('element.duplicate', { refs: referencesOr(refs), offset: offset }));
      },
      connect: function (tool, from, to, at) {
        var fields = { tool: tool, from: from, to: to, label: null };
        if (at) fields.at = at;
        return run(operation('relation.add', fields));
      },
      rewire: function (ref, end, to) {
        return run(operation('relation.rewire', { ref: ref, end: end, to: to }));
      },
      invert: function (ref) {
        return run(operation('relation.invert', { ref: ref }));
      },
      move: function (positions, routes) {
        return run(operation('layout.set', { positions: positions || {}, routes: routes || [] }));
      },
      // Puts the element `ref` into the element `parent`, or at the top level for null (spec §3.4, element.reparent).
      reparent: function (ref, parent) {
        return run(operation('element.reparent', { ref: ref, parent: parent }));
      },
      // Takes branch `branch` (its index, from 0) of the fragment `ref` away (plan Task 38, fragment.removeBranch).
      removeBranch: function (ref, branch) {
        return run(operation('fragment.removeBranch', { ref: ref, branch: branch }));
      },
      reset: function (target) {
        return run(operation('layout.reset', { target: target }));
      }
    };
  }

  /**
   * The classic commands: the UML editor's commands, its tool state (`toolState`: the active palette tool and the
   * relation a click on its first end has started), and how it reports a verdict (announce, showVerdict).
   *
   * The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
   * (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession): it takes the
   * values and the session's functions it uses when it is made, and what it uses of the other parts when the session
   * calls its link(), once every part and the pointer driver exist. Its members join the kit.
   * The tool state is one record, `toolState`, since the commands, the gestures, and the menus share it; its
   * readers write `toolState.activeTool` and `toolState.pendingRelation` where they wrote `activeTool` and
   * `pendingRelation`. deleteSelected reads the activation bars of the last drawing through `activationBars()`.
   */
  function createClassicCommands(kit) {
    // What the session made this part with.
    var SEQUENCE_FRAGMENT_KINDS = kit.SEQUENCE_FRAGMENT_KINDS;
    var activationBars = kit.activationBars;
    var activityLayoutIdForNode = kit.activityLayoutIdForNode;
    var adapter = kit.adapter;
    var clampSlot = kit.clampSlot;
    var diagramSupportsAnchoredNotes = kit.diagramSupportsAnchoredNotes;
    var diagramSupportsCreation = kit.diagramSupportsCreation;
    var env = kit.env;
    var escapeQuoted = kit.escapeQuoted;
    var findEditableElements = kit.findEditableElements;
    var findEditableRoutes = kit.findEditableRoutes;
    var findElementSchema = kit.findElementSchema;
    var findInsertPointForDeclaration = kit.findInsertPointForDeclaration;
    var focusLayoutTarget = kit.focusLayoutTarget;
    var host = kit.host;
    var identifierFromInlineLabel = kit.identifierFromInlineLabel;
    var output = kit.output;
    var refreshActiveButtonStates = kit.refreshActiveButtonStates;
    var relationEndpointsAsDrawn = kit.relationEndpointsAsDrawn;
    var relationFields = kit.relationFields;
    var relationOfLine = kit.relationOfLine;
    var resetOneBtn = kit.resetOneBtn;
    var sceneOf = kit.sceneOf;
    var selectWhenDrawn = kit.selectWhenDrawn;
    var selectedLayout = kit.selectedLayout;
    var selectedLayoutPrimaryId = kit.selectedLayoutPrimaryId;
    var selection = kit.selection;
    var selectionSize = kit.selectionSize;
    var sequenceMessageBlockForLine = kit.sequenceMessageBlockForLine;
    var sequenceMessageLineIndices = kit.sequenceMessageLineIndices;
    var setSelectedLayoutId = kit.setSelectedLayoutId;
    var textGrammar = kit.textGrammar;
    // What the other parts and the pointer driver give this part, bound by link() once all of them exist.
    var collectConnectedRoutes, collectPositions, shiftPersistedRouteEndpoints;

    // The diagram type of the document as the adapter reads it now.
    function documentType() { return adapter.contents().type; }
    // An operation of spec §3.4 as a command builds it (see buildOperationOf).
    function buildOperation(op, fields, facts, undoKey) {
      return buildOperationOf(adapter, op, fields, facts, undoKey);
    }
    // The tool status line: an armed tool's or a mode's instruction (host.status), or a result. A result that reports a
    // verdict passes it on (`verdict`), so a host can show its offer (spec §2.4 `announce`).
    function announce(msg, isActive, verdict) {
      if (isActive) host.status(msg || '', { kind: 'tool' });
      else if (verdict) host.announce(msg || '', { assertive: false, verdict: verdict });
      else host.announce(msg || '', { assertive: false });
    }
    // ─── Source-modification helpers (used by the visual creation tools) ───
    // The active palette tool (null | { kind: 'element'|'relation', spec, type }) and the relation a click on its
    // first end has started (null | { spec, sourceId }): one record, which the commands, gestures, and menus share.
    var toolState = { activeTool: null, pendingRelation: null };
    // The scene facts of a relation.add: in a sequence diagram, where every relation is a message, the
    // line it goes before (`{ beforeLine }`) or null for the end of the document.
    function relationAddFacts(at) {
      return documentType() === 'sequence' ? { at: at } : {};
    }
    // ─── Scene facts of a layout move (spec §3.4, layout.set) ───
    function boxFact(box) {
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    }
    // The boxes a pointer move carries, as they were drawn when it started: the dragged box first,
    // then the other selected boxes.
    function movedBoxesOf(state) {
      var ids = [state.item.id];
      (state.groupItems || []).forEach(function (g) {
        if (ids.indexOf(g.item.id) === -1) ids.push(g.item.id);
      });
      var startBoxes = {};
      startBoxes[state.item.id] = state.box;
      (state.groupItems || []).forEach(function (g) { startBoxes[g.item.id] = g.item.box; });
      return ids.map(function (id) { return { id: id, box: boxFact(startBoxes[id]) }; });
    }
    // The stored routes a move shifted (spec §3.4, layout.set), by their storage keys: the stored bends
    // of each line with an end on a moved box, moved with that end as the drawing moved them.
    function shiftedStoredRoutes(connectedRoutes, moved, delta) {
      if (!connectedRoutes.length) return {};
      var stored = adapter.contents().layoutRoutes;
      var routes = Object.assign({}, stored);
      var deltas = {};
      moved.forEach(function (entry) { deltas[entry.id] = delta; });
      shiftPersistedRouteEndpoints(routes, connectedRoutes, deltas);
      var shifted = {};
      Object.keys(routes).forEach(function (key) {
        if (routes[key] !== stored[key]) shifted[key] = routes[key];
      });
      return shifted;
    }
    // Where each moved box of a deployment drawing lands (spec §3.4, layout.set): whether it still lies
    // inside its parent's drawn box (null when it has no parent, or the parent is not drawn), and which
    // nested node's drawn box holds its new centre (null for none). The nodes around the box, what it
    // contains, and the other moved boxes are no such node: they are drawn where the move leaves them.
    function deploymentNestingFacts(svg, moved, delta) {
      if (!moved.length) return [];
      var reading = adapter.contents();
      var nesting = reading.deploymentNesting;
      var movedIds = moved.map(function (entry) { return entry.id; });
      return moved.map(function (entry) {
        var id = entry.id;
        if (!entry.box) return { id: id, insideParent: null, nestedNodeAtCentre: null };
        var box = { x: entry.box.x + delta.x, y: entry.box.y + delta.y, width: entry.box.width, height: entry.box.height };
        var parentId = nesting.byId[id] && nesting.byId[id].parentId;
        var parentBox = parentId ? env.bundle.UMLShared.renderedLayoutBox(svg, parentId) : null;
        var related = nesting.ancestorsOf(id).concat(reading.ownedElementIds(id, 'deployment'), [id]);
        var cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        var nestedNodeAtCentre = null;
        for (var n = 0; n < nesting.elements.length && nestedNodeAtCentre === null; n++) {
          var nodeId = nesting.elements[n].name;
          if (!nesting.isNestedNode(nodeId) || related.indexOf(nodeId) !== -1 || movedIds.indexOf(nodeId) !== -1) continue;
          var nodeBox = env.bundle.UMLShared.renderedLayoutBox(svg, nodeId);
          if (nodeBox && containsPoint(nodeBox, cx, cy, 0)) nestedNodeAtCentre = nodeId;
        }
        return { id: id, insideParent: parentBox ? containsBox(parentBox, box, 1) : null, nestedNodeAtCentre: nestedNodeAtCentre };
      });
    }
    // Saved positions are absolute, so contained elements that are not moved
    // themselves follow their node by the same offset: the places a move of
    // deployment nodes carries what they contain to, as the drawing shows them.
    function carriedDeploymentPositions(drawnPositions, moved, delta) {
      var reading = adapter.contents();
      var movedIds = moved.map(function (entry) { return entry.id; });
      var carried = {};
      movedIds.forEach(function (id) {
        reading.ownedElementIds(id, 'deployment').forEach(function (childId) {
          if (movedIds.indexOf(childId) !== -1 || carried[childId] || !drawnPositions[childId]) return;
          carried[childId] = { x: drawnPositions[childId].x + delta.x, y: drawnPositions[childId].y + delta.y };
        });
      });
      return carried;
    }
    // A layout.set operation: `positions` are the moved boxes' new places and `routes` the changed
    // bends (a drawn route `{ id, index, points }` each). Its facts are every drawn position and the
    // stored routes the move shifted, and in a deployment drawing where each moved box lands and the
    // places of what the moved nodes carry along.
    function layoutSetOperation(svg, move) {
      var facts = {
        positions: move.drawnPositions,
        shiftedRoutes: shiftedStoredRoutes(move.connectedRoutes, move.moved, move.delta)
      };
      if (documentType() === 'deployment') {
        facts.nesting = deploymentNestingFacts(svg, move.moved, move.delta);
        facts.carried = carriedDeploymentPositions(move.drawnPositions, move.moved, move.delta);
      }
      return buildOperation('layout.set', { positions: move.positions, routes: move.routes }, facts, move.undoKey);
    }
    // The layout.set that gives the drawn line `route` of `svg` the points `points` (spec §3.4, §3.11): the line's
    // `routes` entry, whose storage key the adapter resolves from its id and index, and the scene facts of a route
    // drag's drop, which moves no box. The route drag drops with it, and so does every bend command.
    function routeLayoutSetOperation(svg, route, points, undoKey) {
      return layoutSetOperation(svg, {
        positions: {},
        routes: [{ id: route.id, index: route.index, points: points }],
        drawnPositions: collectPositions(findEditableElements(svg)),
        moved: [],
        delta: { x: 0, y: 0 },
        connectedRoutes: [],
        undoKey: undoKey
      });
    }
    // ─── Scene facts of an addition or a duplicate (spec §3.4, element.add, element.duplicate) ───
    // Every drawn position, as a move records them.
    function drawnPositions() {
      var svg = output.querySelector('svg');
      return svg ? collectPositions(findEditableElements(svg)) : {};
    }
    // Where the originals of a duplicate are drawn: the box of each one's hit target.
    function originalsDrawnPositions(ids) {
      var svg = output.querySelector('svg');
      var positions = {};
      ids.forEach(function (id) {
        var hb = svg && svg.querySelector('.uml-pg-edit-hitbox[data-layout-id="' + cssAttrEscape(id) + '"]');
        if (hb && hb.getBBox) {
          var bb = hb.getBBox();
          positions[id] = { x: Math.round(bb.x), y: Math.round(bb.y) };
        }
      });
      return positions;
    }
    // The anchor at the end of the document: before its last @enduml (spec §3.4, `at`).
    function endOfDocumentAnchor() {
      return { beforeLine: findInsertPointForDeclaration(adapter.contents().lines) };
    }
    // The line of the framed document a message or fragment dropped at `canvasY` goes before: the scene's
    // anchor, or before the last @enduml when the drawing has none.
    function sequenceInsertLineForY(svg, canvasY, excludeRouteId, opts) {
      opts = opts || {};
      var reading = adapter.contents();
      var anchor = readScene(svg, reading, env.bundle).anchorAt(canvasY, reading, { route: excludeRouteId, fragment: opts.excludeFragId });
      return anchor.beforeLine === null ? findInsertPointForDeclaration(reading.sequenceLines) : anchor.beforeLine;
    }
    function addSequenceRelationAtLine(spec, sourceId, targetId, insertAtLine) {
      if (!spec || !sourceId || !targetId) return false;
      adapter.apply(buildOperation('relation.add', { tool: spec.id, from: sourceId, to: targetId, label: null },
        relationAddFacts({ beforeLine: insertAtLine }), 'seq-add-message'));
      announce('Added ' + spec.label + ' message from "' + sourceId + '" to "' + targetId + '". Tool stays active - drag another message or press Esc.', true);
      return true;
    }
    function addSequenceRelationAtY(svg, spec, sourceId, targetId, canvasY) {
      return addSequenceRelationAtLine(spec, sourceId, targetId, sequenceInsertLineForY(svg, canvasY, null));
    }
    function moveSequenceMessageBlockToLine(routeId, insertBeforeLine) {
      var meta = relationInfoForRouteId(routeId);
      var verdict = adapter.apply(buildOperation('message.move',
        { ref: meta.ref, at: { beforeLine: insertBeforeLine } }, {}, 'seq-reorder-message'));
      if (verdict.ok) announce(verdict.message, false);
      return verdict.ok;
    }
    function moveSequenceMessageToY(routeId, svg, canvasY) {
      return moveSequenceMessageBlockToLine(routeId, sequenceInsertLineForY(svg, canvasY, routeId));
    }
    function moveSequenceMessageBy(routeId, delta) {
      var meta = relationInfoForRouteId(routeId);
      if (!meta || meta.lineIdx === -1) {
        announce('Could not locate that message in the source.', false);
        return false;
      }
      var lines = adapter.contents().sequenceLines;
      var indices = sequenceMessageLineIndices(lines);
      var pos = indices.indexOf(meta.lineIdx);
      if (pos === -1) {
        announce('Only sequence messages can be reordered.', false);
        return false;
      }
      var targetPos = pos + delta;
      if (targetPos < 0 || targetPos >= indices.length) {
        announce(delta < 0 ? 'This message is already first.' : 'This message is already last.', false);
        return false;
      }
      var targetBlock = sequenceMessageBlockForLine(lines, indices[targetPos]);
      var insertBefore = delta < 0 ? targetBlock.start : targetBlock.end + 1;
      return moveSequenceMessageBlockToLine(routeId, insertBefore);
    }
    // A fragment.update from Properties: the fragment stays selected once the change is drawn.
    function updateFragmentFromProperties(fragId, operator, guard, undoKey) {
      var awaitingBefore = selectWhenDrawn({ id: fragId, kind: 'fragment' });
      var verdict = adapter.apply(buildOperation('fragment.update', { ref: fragId, operator: operator, guard: guard }, {}, undoKey));
      if (!verdict.ok) selectWhenDrawn(awaitingBefore);
      return verdict;
    }
    function changeFragmentKind(fragId, newKind) {
      newKind = String(newKind || '').toLowerCase().trim();
      if (SEQUENCE_FRAGMENT_KINDS.indexOf(newKind) === -1) return;
      var info = adapter.contents().fragment(fragId);
      if (!info || info.kind === newKind) return;
      var verdict = updateFragmentFromProperties(fragId, newKind, null, 'frag-kind:' + fragId);
      if (verdict.ok) announce(verdict.message, false);
    }
    function changeFragmentCondition(fragId, newCondition) {
      var info = adapter.contents().fragment(fragId);
      if (!info) return;
      var trimmed = String(newCondition || '').trim();
      if (info.condition === trimmed) return;
      updateFragmentFromProperties(fragId, null, { branch: null, text: trimmed }, 'frag-cond:' + fragId);
    }
    function changeFragmentBranchCondition(fragId, branchLineIdx, newCondition) {
      var trimmed = String(newCondition || '').trim();
      updateFragmentFromProperties(fragId, null, { branch: branchLineIdx, text: trimmed }, 'frag-branch:' + fragId + ':' + branchLineIdx);
    }
    function addFragmentElseBranch(fragId, condition) {
      var verdict = adapter.apply(buildOperation('fragment.addBranch',
        { ref: fragId, guard: { text: String(condition || '').trim() } }, {}, 'frag-else:' + fragId));
      if (verdict.ok) announce(verdict.message, false);
    }
    /**
     * Delete a fragment, keeping the messages inside but removing the wrapper
     * (`open` / `else` / `end` lines). Inner messages are dedented by one level.
     */
    function unwrapFragment(fragId) {
      var verdict = adapter.apply(buildOperation('fragment.unwrap', { ref: fragId }, {}, 'frag-unwrap:' + fragId));
      if (verdict.ok) announce(verdict.message, false);
    }
    /**
     * Find the innermost fragment whose body contains the given source line.
     * Returns { info, branchIdx } where branchIdx is 0 for the main branch and
     * 1+ for else-branches. null if the line is not inside a fragment.
     */
    function fragmentForMessageLine(lineIdx) {
      var ranges = adapter.contents().fragments.map(classicFragmentRange);
      // Most-deeply-nested fragment wins — sort by startIdx descending.
      var inside = ranges.filter(function (r) {
        return lineIdx > r.startIdx && lineIdx < r.endIdx;
      }).sort(function (a, b) { return b.startIdx - a.startIdx; });
      if (!inside.length) return null;
      var frag = inside[0];
      // Determine which branch the line belongs to (counting else lines as
      // separators). Branch 0 = before any else; branch 1 = after first else; ...
      var branchIdx = 0;
      for (var i = 0; i < frag.branches.length; i++) {
        if (frag.branches[i].lineIdx < lineIdx) branchIdx++;
        else break;
      }
      return { info: frag, branchIdx: branchIdx };
    }
    /**
     * Move a sequence message into a specific branch of its enclosing fragment.
     * The message is inserted as the LAST line of the chosen branch (just before
     * the next else / end). If the target branch is its current branch, no-op.
     */
    function moveSequenceMessageToBranch(routeId, branchIdx) {
      var meta = relationInfoForRouteId(routeId);
      if (!meta || meta.lineIdx === -1) return false;
      var ctx = fragmentForMessageLine(meta.lineIdx);
      if (!ctx) {
        announce('That message is not inside a fragment.', false);
        return false;
      }
      var frag = ctx.info;
      if (branchIdx < 0) branchIdx = 0;
      var totalBranches = 1 + frag.branches.length;
      if (branchIdx >= totalBranches) branchIdx = totalBranches - 1;
      if (branchIdx === ctx.branchIdx) return false;

      // Compute the line just before the next branch boundary (else / end).
      var boundaryLine;
      if (branchIdx === frag.branches.length) {
        // Last branch — insert just before `end`.
        boundaryLine = frag.endIdx;
      } else {
        // Insert just before the next else line for this branch.
        boundaryLine = frag.branches[branchIdx].lineIdx;
      }

      // The message moves before that boundary, as a message.move to that line does.
      var verdict = adapter.apply(buildOperation('message.move',
        { ref: meta.ref, at: { beforeLine: boundaryLine } }, {}, 'seq-msg-to-branch:' + routeId + ':' + branchIdx));
      if (verdict.ok) announce('Moved message to branch ' + (branchIdx + 1) + '.', false);
      return verdict.ok;
    }
    /**
     * Move a fragment block earlier or later within its sibling order. delta is
     * -1 (earlier) or +1 (later): a fragment.move by that step.
     */
    function moveFragmentBy(fragId, delta) {
      var verdict = adapter.apply(buildOperation('fragment.move', { ref: fragId, at: { step: delta } }, {},
        (delta < 0 ? 'frag-move-up:' : 'frag-move-down:') + fragId));
      if (verdict.message) announce(verdict.message, false);
      return verdict.ok;
    }
    /**
     * Move a fragment block (opener + branches + nested content + end) so that
     * it lands BEFORE the given source line. No-op if that lands inside the
     * fragment itself.
     */
    function moveSequenceFragmentToLine(fragId, insertBeforeLine) {
      var verdict = adapter.apply(buildOperation('fragment.move', { ref: fragId, at: { beforeLine: insertBeforeLine } }, {}, 'frag-move:' + fragId));
      if (verdict.ok) announce(verdict.message, false);
      return verdict.ok;
    }
    function moveSequenceFragmentToY(fragId, svg, canvasY) {
      return moveSequenceFragmentToLine(fragId, sequenceInsertLineForY(svg, canvasY, null, { excludeFragId: fragId }));
    }
    /** Current { startSlot, endSlot, msgCount } of a bar from the live source. */
    function activationBarSlots(bar) {
      var lines = adapter.contents().sequenceLines;
      var msgRows = sequenceMessageLineIndices(lines);
      function slotOf(lineIdx) {
        if (lineIdx == null) return null;
        var c = 0;
        for (var i = 0; i < msgRows.length; i++) { if (msgRows[i] < lineIdx) c++; }
        return c;
      }
      return { startSlot: slotOf(bar.startLine), endSlot: slotOf(bar.endLine), msgCount: msgRows.length };
    }
    /**
     * Rewrite a bar's `activate` / `deactivate` lines so it starts at
     * `newStartSlot` and ends at `newEndSlot` (null end = open-ended, no
     * `deactivate`): an activation.set. Re-renders and re-selects the bar.
     * Returns false if the source changed underneath us.
     */
    function setActivationBarSlots(bar, newStartSlot, newEndSlot, undoKind, announceMsg) {
      var verdict = adapter.apply(buildOperation('activation.set', {
        ref: { id: bar.id, startLine: bar.startLine, endLine: bar.endLine },
        lifeline: bar.target,
        slots: { start: newStartSlot, end: newEndSlot }
      }, {}, undoKind || 'activation-edit'));
      if (verdict.ok && announceMsg) announce(announceMsg, false);
      return verdict.ok;
    }
    /**
     * Create a new activation bar on lifeline `targetId` spanning message slots
     * [startSlot, endSlot]: an activation.add. Used by the Activate tool (click / drag-to-span).
     */
    function createActivationBar(targetId, startSlot, endSlot) {
      var verdict = adapter.apply(buildOperation('activation.add',
        { lifeline: targetId, slots: { start: startSlot, end: endSlot } }, {}, 'activation-create'));
      if (verdict.ok) announce(verdict.message, true);
      return verdict.ok;
    }
    /** Keyboard adjust: move the start / end / whole bar by one message slot. */
    function activationNudge(bar, which, dir) {
      var s = activationBarSlots(bar);
      var newStart = s.startSlot;
      var newEnd = s.endSlot;
      if (which === 'start') {
        newStart = clampSlot(newStart + dir, 0, newEnd == null ? s.msgCount : newEnd);
      } else if (which === 'end') {
        if (newEnd == null) newEnd = s.msgCount;
        newEnd = clampSlot(newEnd + dir, newStart, s.msgCount);
      } else {
        newStart = clampSlot(newStart + dir, 0, s.msgCount);
        if (newEnd != null) newEnd = clampSlot(newEnd + dir, newStart, s.msgCount);
      }
      if (newStart === s.startSlot && newEnd === s.endSlot) {
        announce('Activation is already at the ' + (dir < 0 ? 'top' : 'bottom') + '.', false);
        return;
      }
      var label = bar.target || 'object';
      var verb = which === 'move' ? 'moved' : ('now ' + (which === 'start' ? 'starts' : 'stops') + ' ' + (dir < 0 ? 'earlier' : 'later'));
      setActivationBarSlots(bar, newStart, newEnd, 'activation-nudge', 'Activation of "' + label + '" ' + verb + '.');
    }
    function isRelationLineFor(line, type, sourceId, targetId, op) {
      var t = line.trim();
      // Test plain `A op B` ignoring multiplicity quotes / labels.
      var stripped = t.replace(/"((?:[^"\\]|\\.)*)"\s*/g, '').replace(/\s*:.*$/, '').trim();
      var parts = stripped.split(/\s+/);
      if (parts.length < 3) return false;
      var s = parts[0], operator = parts.slice(1, parts.length - 1).join(' '), tg = parts[parts.length - 1];
      if (op && operator !== op) return false;
      // Case-insensitive symmetric match for plain associations.
      return (s === sourceId && tg === targetId) || (s === targetId && tg === sourceId);
    }
    function activityNodeInfoForId(id) {
      if (!env.bundle.UMLActivityDiagram || typeof env.bundle.UMLActivityDiagram.parse !== 'function') return null;
      try {
        var parsed = adapter.contents().activityModel();
        var nodes = parsed.nodes || [];
        for (var i = 0; i < nodes.length; i++) {
          if (activityLayoutIdForNode(nodes[i]) === id) return nodes[i];
        }
      } catch (e) {
        return null;
      }
      return null;
    }
    function sequenceElementCanAddWithoutCanvas(spec) {
      if (!spec || documentType() !== 'sequence') return false;
      return spec.id === 'actor' || spec.id === 'participant' || !!spec.sequenceFragment;
    }
    function elementCanAddWithoutCanvas(spec) {
      if (!spec) return false;
      var type = documentType();
      if (type === 'sequence') return sequenceElementCanAddWithoutCanvas(spec);
      return !!diagramSupportsCreation(type) && !spec.isNote && !spec.sequenceControl && !spec.sequenceNote;
    }
    function addElementWithoutCanvas(spec) {
      var type = documentType();
      if (!elementCanAddWithoutCanvas(spec)) {
        if (spec && spec.isNote && diagramSupportsAnchoredNotes(type)) {
          announce('Add an element first, then click it with the Note tool.', true);
        }
        return false;
      }
      if (type === 'sequence') {
        if (spec.id === 'actor' || spec.id === 'participant') addSequenceParticipant(spec.id);
        else placeElementAt(spec, { x: 120, y: 60 }, 'automatic');
        return true;
      }
      var svg = output.querySelector('svg');
      var items = svg ? findEditableElements(svg) : [];
      placeElementAt(spec, freePlaceRightOf(items.map(function (item) { return item.box; })), 'automatic');
      focusLayoutTarget(selectedLayoutPrimaryId());
      return true;
    }
    // An actor or a participant after the last lifeline; returns its identifier.
    function addSequenceParticipant(kind) {
      var tool = kind === 'actor' ? 'actor' : 'participant';
      if (!findElementSchema('sequence', tool)) return null;
      var verdict = adapter.apply(buildOperation('lifeline.add', { tool: tool, name: null }, {}, null));
      announce(verdict.message, false);
      return verdict.select.id;
    }
    function addSequenceStarterPair() {
      var verdict = adapter.apply(buildOperation('lifeline.add', { tool: 'starter', name: null }, {}, null));
      announce(verdict.message, false);
    }
    // The starter of the empty class diagram (a class realizing an interface) or of the empty
    // state machine (initial, Idle, Done, and final).
    function addDiagramStarter() {
      var verdict = adapter.apply(buildOperation('element.add',
        { tool: 'starter', name: null, into: null, anchor: null, placed: 'automatic' },
        { at: null, positions: drawnPositions() }, null));
      announce(verdict.message, false);
    }
    function addEmptyElement(type, specId) {
      var spec = findElementSchema(type, specId);
      if (!spec) return;
      placeElementAt(spec, { x: 120, y: 80 }, 'automatic');
    }
    function setActiveTool(kind, spec) {
      if (!kind) {
        toolState.activeTool = null;
        toolState.pendingRelation = null;
      } else {
        toolState.activeTool = { kind: kind, spec: spec, type: documentType() };
        toolState.pendingRelation = null;
      }
      // A host surface has no palette buttons of the module's to mark (plan Task 42).
      if (refreshActiveButtonStates) refreshActiveButtonStates();
      // Clear pending source highlight.
      var layer = output.querySelector('.uml-pg-edit-layer');
      if (layer) {
        Array.prototype.slice.call(layer.querySelectorAll('.is-relation-source')).forEach(function (el) {
          el.classList.remove('is-relation-source');
        });
      }
      if (!toolState.activeTool) { announce(''); return; }
      if (toolState.activeTool.kind === 'element') {
        if (documentType() === 'sequence' && (spec.sequenceControl || spec.sequenceNote)) {
          announce('Click a lifeline to add ' + spec.label + '. Press Esc to cancel.', true);
        } else if (diagramSupportsAnchoredNotes(documentType()) && spec.isNote) {
          announce('Click a diagram element to attach a note. Press Esc to cancel.', true);
        } else {
          announce('Click on the diagram to add a ' + spec.label + '. Press Esc to cancel.', true);
        }
      } else if (documentType() === 'sequence' && spec.sequenceSingle) {
        announce(spec.sequenceSingle === 'found'
          ? 'Click a lifeline (or drag from the empty point) at the height where the ' + spec.label + ' message should arrive. Press Esc to cancel.'
          : 'Click a lifeline (or drag from it) at the height where the ' + spec.label + ' message should start. Press Esc to cancel.', true);
      } else if (documentType() === 'sequence') {
        announce('Drag from one lifeline to another to add a ' + spec.label + ' message, or click source then target. Press Esc to cancel.', true);
      } else {
        announce('Click the source element for a ' + spec.label + ' relation. Press Esc to cancel.', true);
      }
    }
    // The undo coalescing key of a placement: folder-tree and git-graph rows added in quick succession
    // are one undo step, as they always have been; any other placement is a step of its own.
    function placementUndoKey(type, spec) {
      if (type === 'folder-tree' && spec.folderTreeKind) return 'folder-tree-add';
      if (type === 'gitgraph' && spec.gitBranch) return 'gitgraph-add-branch';
      if (type === 'gitgraph' && spec.gitCommit) return 'gitgraph-add-commit';
      return null;
    }
    // The element.add of the palette tool `spec` placed at `pt` (spec §3.4); `into` is the component or
    // node it goes inside.
    function placementOperation(spec, pt, placed, into) {
      return buildOperation('element.add',
        { tool: spec.id, name: null, into: into, anchor: null, placed: placed || 'dropped' },
        { at: pt, positions: drawnPositions() }, placementUndoKey(documentType(), spec));
    }
    // Places a palette tool's element at the canvas point `pt`; `placed` is 'automatic' when the
    // editor chose the point (a key, an empty canvas) and 'dropped' (the default) when the learner did.
    function placeElementAt(spec, pt, placed) {
      var type = documentType();
      if (type === 'sequence' && (spec.sequenceControl || spec.sequenceNote)) {
        setActiveTool('element', spec);
        announce('Click a lifeline to add ' + spec.label + '.', true);
        return;
      }
      if (diagramSupportsAnchoredNotes(type) && spec.isNote) {
        setActiveTool('element', spec);
        announce('Click a diagram element to attach a note. Press Esc to cancel.', true);
        return;
      }
      if (type === 'gitgraph' && (spec.gitBranch || spec.gitCommit)) {
        // The row the model panel's buttons add, announced as they announce it. A new commit is
        // selected after the drawing, so it shows selected from the next drawing on.
        var row = adapter.apply(placementOperation(spec, pt, placed, null));
        if (row.select) selectWhenDrawn({ id: row.select.ids[0], kind: 'node' });
        announce(row.message, false);
        return;
      }
      // Sequence fragments insert a stub block at the end of the source.
      if (type === 'sequence' && spec.sequenceFragment) {
        adapter.apply(buildOperation('fragment.add', { operator: spec.sequenceFragment, at: endOfDocumentAnchor() }, {}, null));
        return;
      }
      // A newly placed classifier is ready for naming and member entry.
      var clearToolAfterPlacement = type === 'class' ||
        (type === 'sequence' && spec && (spec.id === 'actor' || spec.id === 'participant'));
      // Ports / interfaces dropped onto a component go inside that component, and a component or
      // an artifact dropped onto a deployment node goes inside that node.
      var into = null;
      if (type === 'component' && (spec.isPort || spec.isInterface)) into = findContainerAtSvgPoint(pt);
      if (type === 'deployment' && (spec.id === 'component' || spec.id === 'artifact')) into = findContainerAtSvgPoint(pt);
      var verdict = adapter.apply(placementOperation(spec, pt, placed, into));
      // The state pseudostates' instructions are the only announcement of a placement.
      if (verdict.message) announce(verdict.message, true);
      if (into && type === 'component') {
        // A port drop draws the component once more with its port selected, as it always has.
        selectWhenDrawn({ id: into, kind: 'node' });
        host.redraw();
      }
      if (clearToolAfterPlacement) setActiveTool(null);
    }
    /** Find the topmost component element under the given SVG-coord point. */
    // What an addition dropped at `pt` goes into: in a component drawing the component there (for a port or
    // an interface), in a deployment drawing the node there (for a component or an artifact).
    function findContainerAtSvgPoint(pt) {
      var svg = output.querySelector('svg');
      if (!svg) return null;
      return sceneOf(svg).containerAt(pt);
    }
    /** Insert a port/interface line inside the host component's body. */
    // Its undo step has no coalescing key.
    function addPortIntoComponent(componentId, spec, newPortId, label) {
      var line = adapter.contents().declarationLine(componentId, 'component');
      if (!line) return;
      replaceLineForElementId(componentId, textGrammar.componentDeclarationWithPort(line, spec, newPortId, label, env.bundle), null);
    }
    function routeIdForSourceLine(svg, lineIdx) {
      var type = documentType();
      var reading = adapter.contents();
      var lines = reading.lines;
      var indices = reading.relationLines;
      var route = findEditableRoutes(svg).find(function (candidate) {
        return relationLineMatchForRouteId(String(candidate.id), type, lines, indices).lineIdx === lineIdx;
      });
      return route ? route.id : null;
    }
    // Duplicate from an element's context menu. An element without a declaration (a pseudostate, for
    // one) is not copied, and nothing says so, as always.
    function duplicateElement(id) {
      adapter.apply(buildOperation('element.duplicate',
        { refs: [id], offset: { x: 30, y: 30 }, scope: 'element' },
        { positions: originalsDrawnPositions([id]) }, null));
    }
    function selectedRelationToolSpec() {
      return toolState.activeTool && toolState.activeTool.kind === 'relation' && toolState.activeTool.spec ? toolState.activeTool.spec : null;
    }
    function connectWithSelectedRelationTool(sourceId, targetId, opts) {
      var spec = selectedRelationToolSpec();
      if (!spec) return false;
      opts = opts || {};
      if (sourceId === targetId && ['class', 'sequence', 'state'].indexOf(documentType()) === -1) {
        announce('Self-relations not supported here.', false);
        return true;
      }
      toolState.pendingRelation = null;
      // `snapshot: false`: the relation joins the undo step of the element the extend handle just added.
      function connected(from, to) {
        var operation = buildOperation('relation.add', { tool: spec.id, from: from, to: to, label: null }, relationAddFacts(null), null);
        adapter.apply(opts.snapshot === false ? joiningPreviousStep(operation) : operation);
      }
      if (documentType() === 'sequence' && spec.sequenceSingle) {
        var endpointId = spec.sequenceSingle === 'found' ? targetId : sourceId;
        connected(endpointId, endpointId);
        announce('Added ' + spec.label + ' message ' + (spec.sequenceSingle === 'found' ? 'to' : 'from') + ' "' + endpointId + '". Tool stays active - add another message or press Esc.', true);
        return true;
      }
      connected(sourceId, targetId);
      announce('Connected "' + sourceId + '" to "' + targetId + '" with ' + spec.label + '. Tool stays active - add another relation or press Esc.', true);
      return true;
    }
    function handleHitboxClickForSequenceElementTool(item) {
      if (!toolState.activeTool || toolState.activeTool.kind !== 'element' || documentType() !== 'sequence') return false;
      var spec = toolState.activeTool.spec || {};
      if (!spec.sequenceControl && !spec.sequenceNote) return false;
      // Activate tool on a lifeline head: drop a real, adjustable bar starting
      // at the lifeline's first message (the user then drags its edges) rather
      // than appending a stray `activate` line at the bottom of the source.
      if (spec.sequenceControl === 'activate') {
        var seqLines = adapter.contents().sequenceLines;
        var msgRows = sequenceMessageLineIndices(seqLines);
        var startSlot = 0;
        for (var s = 0; s < msgRows.length; s++) {
          if (lineMentionsId(seqLines[msgRows[s]], item.id)) { startSlot = s; break; }
        }
        return createActivationBar(item.id, startSlot, startSlot + 1);
      }
      var verdict = adapter.apply(buildOperation('element.add',
        { tool: spec.id, name: null, into: null, anchor: item.id, placed: 'dropped' },
        { at: null, positions: drawnPositions() }, null));
      announce(verdict.message, false);
      return true;
    }
    function handleHitboxClickForAnchoredNoteTool(item) {
      if (!toolState.activeTool || toolState.activeTool.kind !== 'element') return false;
      var type = documentType();
      var spec = toolState.activeTool.spec || {};
      if (!diagramSupportsAnchoredNotes(type) || !spec.isNote) return false;
      if (!item || item.axis === 'note' || /^note:/.test(String(item.id || ''))) {
        announce('Click a diagram element to attach the note.', true);
        return true;
      }
      var facts = { at: null, positions: drawnPositions() };
      // The note tool is put down before the note is drawn.
      setActiveTool(null);
      var verdict = adapter.apply(buildOperation('element.add',
        { tool: spec.id, name: null, into: null, anchor: item.id, placed: 'dropped' }, facts, null));
      announce(verdict.message, false);
      return true;
    }
    function addSequenceSingleMessage(spec, endpointId, opts) {
      if (!spec || !spec.sequenceSingle || !endpointId) return false;
      opts = opts || {};
      var hasY = opts.svg && Number.isFinite(opts.canvasY);
      // A click or a drag places the message at the height where it started; the keyboard at the end.
      var at = hasY ? { beforeLine: sequenceInsertLineForY(opts.svg, opts.canvasY, null) } : null;
      adapter.apply(buildOperation('relation.add', { tool: spec.id, from: endpointId, to: endpointId, label: null },
        relationAddFacts(at), null));
      announce('Added ' + spec.label + ' message ' + (spec.sequenceSingle === 'found' ? 'to' : 'from') + ' "' + endpointId + '". Tool stays active — pick another lifeline or press Esc.', true);
      return true;
    }
    function handleHitboxClickForRelation(item, hitbox) {
      if (!toolState.activeTool || toolState.activeTool.kind !== 'relation') return false;
      if (documentType() === 'sequence' && toolState.activeTool.spec && toolState.activeTool.spec.sequenceSingle) {
        return addSequenceSingleMessage(toolState.activeTool.spec, item.id);
      }
      if (!toolState.pendingRelation) {
        toolState.pendingRelation = { spec: toolState.activeTool.spec, sourceId: item.id };
        // Highlight pending source
        if (hitbox && hitbox.classList) hitbox.classList.add('is-relation-source');
        announce('Now click the target element for a ' + toolState.activeTool.spec.label + ' relation from "' + item.id + '". Press Esc to cancel.', true);
        return true;
      }
      var sourceId = toolState.pendingRelation.sourceId;
      var targetId = item.id;
      if (sourceId === targetId && ['class', 'sequence', 'state'].indexOf(documentType()) === -1) {
        announce('Pick a different target — self-loops are not supported here. Press Esc to cancel.', true);
        return true;
      }
      var spec = toolState.pendingRelation.spec;
      toolState.pendingRelation = null;
      // The relation tool is put down before the relation is drawn.
      setActiveTool(null);
      // Clear visual highlight
      var layer = output.querySelector('.uml-pg-edit-layer');
      if (layer) {
        Array.prototype.slice.call(layer.querySelectorAll('.is-relation-source')).forEach(function (el) {
          el.classList.remove('is-relation-source');
        });
      }
      adapter.apply(buildOperation('relation.add', { tool: spec.id, from: sourceId, to: targetId, label: null },
        relationAddFacts(null), null));
      announce('Connected "' + sourceId + '" to "' + targetId + '". Edit the selected relation in Properties.', false);
      return true;
    }
    function commitWrap(kind, condition) {
      // Collect line indices for currently-selected route ids.
      var rIndices = adapter.contents().relationLines;
      var lineIdxs = [];
      selectedLayout.all().forEach(function (selected) {
        if (selected.kind !== 'route') return;
        var ord = String(selected.id).match(/^edge[-:_](\d+)$/);
        if (ord && rIndices[Number(ord[1])] != null) {
          lineIdxs.push(rIndices[Number(ord[1])]);
        }
      });
      if (!lineIdxs.length) {
        announce('Could not locate the selected messages in the source.', false);
        return;
      }
      lineIdxs.sort(function (a, b) { return a - b; });
      var first = lineIdxs[0];
      var last = lineIdxs[lineIdxs.length - 1];

      adapter.apply(buildOperation('fragment.add',
        { operator: kind, wrap: { fromLine: first, toLine: last }, guard: { text: condition } }, {}, null));
      announce('Wrapped ' + lineIdxs.length + ' message' + (lineIdxs.length === 1 ? '' : 's') + ' in ' + kind + '.', false);
    }
    // Generic helper: replace the source line for an element id with a new line.
    // Handles multi-line `{ ... }` blocks too — collapses the whole block into newLine.
    // By default the step coalesces by element id, so rapid attribute edits in the props panel
    // become a single undo step; `undoKey` (null for none) replaces that key.
    function replaceLineForElementId(elementId, newLine, undoKey) {
      adapter.apply(buildOperation('source.replaceDeclaration', { ref: elementId, text: newLine }, {},
        undoKey === undefined ? 'edit:' + elementId : undoKey));
    }
    // The verdict of a rename, an update, or a member change, shown as today's commands showed it: a
    // refusal's sentence at once, a selection that waits for the next drawing then, and the sentence
    // of the change.
    function showVerdict(verdict) {
      if (!verdict.ok) {
        if (verdict.message) announce(verdict.message, true);
        return;
      }
      if (verdict.select && verdict.select.ids) selectWhenDrawn({ id: verdict.select.ids[0], kind: verdict.select.kind });
      if (verdict.message) announce(verdict.message, false);
    }
    // An activity action's text is its identity.
    function renameActivityElement(oldId, newLabel) {
      showVerdict(adapter.apply(buildOperation('element.rename', { ref: oldId, text: newLabel, part: 'action' }, {}, 'activity-rename:' + oldId)));
    }
    function renameElement(oldId, newId) {
      // An activity action has no declaration: its rename is the action's, under that rename's undo key.
      var actionKey = documentType() === 'activity' && adapter.contents().declarationLine(oldId, 'activity') == null
        ? 'activity-rename:' + oldId
        : null;
      showVerdict(adapter.apply(buildOperation('element.rename', { ref: oldId, text: newId, part: 'identifier' }, {}, actionKey)));
    }
    // The drawn endpoints of a route whose id is an ordinal (edge-N, usecase:N).
    // The line a drawn route resolves to (`lineIdx`, or -1 unless exactly one line matches), its text,
    // the relation lines the route can stand for (`candidates`), and the ends an edge:A|B id names: the
    // scene's match against `lines`, the document of `type` without its layout metadata, and its relation
    // lines `relationIndices` (read from `lines` when not given).
    function relationLineMatchForRouteId(routeId, type, lines, relationIndices) {
      var reading = {
        type: type,
        lines: lines,
        get elements() { return adapter.contents().elements; },
        get relations() {
          var indices = relationIndices || textGrammar.relationLineIndices(lines.join('\n'), type, env.bundle);
          return relationEndpointsAsDrawn(type, lines, indices, env.bundle).map(function (ends) {
            return { line: ends.lineIdx, from: ends.source, to: ends.target, label: ends.label };
          });
        }
      };
      return readScene(output.querySelector('svg'), reading, env.bundle).relationMatch(routeId, reading);
    }
    // The relation reference of a drawn route (spec §3.4), resolved on the drawing against the contents
    // `reading` a command took: `{ routeId, line, candidates }`.
    function relationReference(routeId, reading) {
      return readScene(output.querySelector('svg'), reading, env.bundle).relationRef(routeId, reading);
    }
    // A drawn route's reference, its line and that line's text, and the relation written there.
    function relationInfoForRouteId(routeId) {
      var reading = adapter.contents();
      var lines = reading.lines;
      var ref = relationReference(String(routeId || ''), reading);
      var lineText = ref.line === -1 ? '' : lines[ref.line];
      return { id: ref.routeId, lineIdx: ref.line, lineText: lineText, info: relationOfLine(lineText, documentType(), ref.routeId), ref: ref };
    }
    // The Properties form's and the in-place label editor's change of the relation `ref`: its line is
    // rebuilt from the relation as the editor holds it. As today, the route that is selected is
    // selected again once the change is drawn; a refused change draws nothing and stages nothing.
    function replaceRelationLine(ref, info) {
      var awaitingBefore = selectWhenDrawn({ id: selectedLayoutPrimaryId(), kind: 'route' });
      var verdict = adapter.apply(buildOperation('relation.update',
        { ref: ref, changes: { relation: relationFields(info) } }, {}, 'rel:' + ref.line));
      if (!verdict.ok) selectWhenDrawn(awaitingBefore);
    }
    // The Properties form moves the end `side` of the relation `ref`, which it holds as `info`, to the
    // element `endpointId`.
    function rewireRelationEndpoint(ref, info, side, endpointId) {
      var verdict = adapter.apply(buildOperation('relation.rewire',
        { ref: ref, end: side, to: String(endpointId || '').trim(), relation: relationFields(info) }, {}, 'rel-rewire:' + ref.line));
      if (verdict.message) announce(verdict.message, false);
    }
    function invertRelationDirection(routeId) {
      var ref = relationReference(String(routeId || ''), adapter.contents());
      var verdict = adapter.apply(buildOperation('relation.invert', { ref: ref }, {}, 'rel-invert:' + ref.line));
      if (verdict.message) announce(verdict.message, false);
    }
    function deleteSelected() {
      if (!selectionSize()) return;
      var entries = selectedLayout.all();
      function ofKind(kind) {
        return entries.filter(function (entry) { return entry.kind === kind; });
      }
      var reading = adapter.contents();
      var operation = buildOperation('selection.remove', {
        elements: entries.filter(function (entry) { return ['route', 'fragment', 'activation'].indexOf(entry.kind) === -1; })
          .map(function (entry) { return entry.id; }),
        // A connection is its relation reference: the line it resolves to on the drawing (or -1 when it
        // matches no one line) and the lines it can stand for.
        relations: ofKind('route').map(function (entry) {
          return relationReference(String(entry.id), reading);
        }),
        fragments: ofKind('fragment').map(function (entry) { return String(entry.id); }),
        // An activation bar is its activate and deactivate lines, as drawn.
        activations: ofKind('activation').map(function (entry) {
          var bar = activationBars()[entry.id];
          return { id: entry.id, startLine: bar ? bar.startLine : null, endLine: bar ? bar.endLine : null };
        })
      }, {}, null);
      var verdict = adapter.apply(operation);
      announce(verdict.message, removesNothing(operation));
    }
    // Whether a selection.remove removes nothing: every selected item is a connection that matches no
    // one line of the source. Delete then announces what it kept at once.
    function removesNothing(operation) {
      return !operation.elements.length && !operation.fragments.length && !operation.activations.length &&
        operation.relations.every(function (relation) { return relation.line === -1; });
    }
    /**
     * Rewrite the visible label of an element while preserving its id (used as
     * the cross-reference key in relations).
     *
     * For schemas that already separate label from id (sequence's
     * `actor user: User` form, use-case's `usecase "Label" as id` form), this
     * just rewrites the label part. For schemas that previously had no
     * separate label (class, state, component, deployment node, ER entity),
     * this introduces a `keyword "Label" as id` alias so the id keeps working.
     */
    function setElementLabel(id, newLabel) {
      var type = documentType();
      if (/^note:\d+$/.test(String(id))) {
        replaceVirtualNoteText(id, newLabel);
        return;
      }
      if (type === 'crc') {
        var card = adapter.contents().crcCard(id);
        if (card && newLabel.trim()) {
          card.name = newLabel.trim();
          host.replaceCrcCard(id, card);
        }
        return;
      }
      if (type === 'sequence') {
        setSequenceLifelineHead(id, newLabel);
        return;
      }
      if (type === 'class' || type === 'state') {
        var nextId = identifierFromInlineLabel(newLabel);
        if (!nextId) return;
        renameElement(id, nextId);
        return;
      }
      if (type === 'activity') {
        renameActivityElement(id, newLabel);
        return;
      }
      if (type === 'deployment' || type === 'er') {
        var nextModelId = identifierFromInlineLabel(newLabel);
        if (!nextModelId) return;
        renameElement(id, nextModelId);
        return;
      }
      if (type === 'venn') {
        renameElement(id, newLabel);
        return;
      }
      var line = adapter.contents().declarationLine(id, type);
      if (line == null) return;
      var t = line.trim();
      // Preserve any trailing { ... } body so members / ports / attributes survive.
      var bodyMatch = t.match(/(\s*\{[\s\S]*\}\s*)$/);
      var body = bodyMatch ? bodyMatch[1] : '';
      var head = bodyMatch ? t.slice(0, -body.length) : t;
      var newHead = rewriteLabelInHead(head, type, id, newLabel);
      if (!newHead) return;
      var newLine = newHead + body;
      replaceLineForElementId(id, newLine);
    }
    function setSequenceLifelineHead(id, newHeadText) {
      showVerdict(adapter.apply(buildOperation('element.rename', { ref: id, text: newHeadText, part: 'head' }, {}, 'rename-sequence:' + id)));
    }
    function virtualNoteText(id) {
      var range = adapter.contents().virtualNoteRange(id);
      if (!range) return '';
      var line = range.lines[range.start] || '';
      var single = line.match(/:\s*(.*)$/);
      if (single) return single[1].trim();
      var body = [];
      for (var i = range.start + 1; i < range.end; i++) {
        if (range.lines[i].trim()) body.push(range.lines[i].replace(/^\s{0,4}/, ''));
      }
      return body.join('\n') || 'Note';
    }
    // A note's id names its first line (`note:<line>`), and its edits coalesce under that line.
    function replaceVirtualNoteText(id, nextText) {
      var noteLine = String(id || '').match(/^note:(\d+)$/);
      var undoKey = noteLine ? 'note:' + Number(noteLine[1]) : null;
      showVerdict(adapter.apply(buildOperation('element.rename', { ref: id, text: nextText, part: 'note' }, {}, undoKey)));
    }
    function rewriteLabelInHead(head, type, id, newLabel) {
      // Returns the rewritten head, or null if the schema is unrecognized.
      var t = head.trim();
      var quotedId = /[\s"<>]/.test(id) ? '"' + escapeQuoted(id) + '"' : id;
      var quotedLbl = '"' + escapeQuoted(newLabel) + '"';

      // Sequence: `actor id: Label` or `participant id: Label`
      if (type === 'sequence') {
        var ms = t.match(/^(actor|participant)\s+(\S+?)(?::\s*.*)?$/i);
        if (ms) return ms[1] + ' ' + ms[2] + ': ' + newLabel;
      }
      // Use-case: `usecase "Label" as id` | `actor "Label" as id` | `actor id` | `rectangle "Label" as id`
      if (type === 'usecase') {
        var mu = t.match(/^(usecase|actor|rectangle)\s+/i);
        if (mu) {
          // Strip current Label/id forms then re-emit
          var kw = mu[1].toLowerCase();
          if (kw === 'actor' && t.match(/^actor\s+\S+\s*$/i) && !/\sas\s+/i.test(t)) {
            // Plain `actor X` — rewrite as `actor "Label" as X`.
            return 'actor ' + quotedLbl + ' as ' + id;
          }
          if (kw === 'rectangle') return 'rectangle ' + quotedLbl;
          return kw + ' ' + quotedLbl + ' as ' + id;
        }
      }
      // Deployment artifact: `artifact "Label" as id`
      if (type === 'deployment') {
        if (/^artifact\b/i.test(t)) return 'artifact ' + quotedLbl + ' as ' + id;
      }
      if (type === 'freeform') {
        var mf = t.match(/^(box(?:\s+[a-z]+)?)\s+"(?:[^"\\]|\\.)*"\s+as\s+\S+(\s+.*)?$/i);
        if (mf) return mf[1] + ' ' + quotedLbl + ' as ' + id + (mf[2] || '');
      }
      if (type === 'venn') {
        return 'set ' + quotedLbl;
      }
      // Notes: `note as id "text"`
      if (/^note\s+as\b/i.test(t)) return 'note as ' + id + ' ' + quotedLbl;

      // Default: introduce a `keyword "Label" as id` alias for class/state/
      // component/node/entity/relationship/etc. Find the keyword (one or two
      // words like `class`, `abstract class`, `weak entity`, `identifying relationship`).
      var keywordMatch = t.match(/^((?:abstract\s+class|weak\s+entity|identifying\s+relationship|class|interface|enum|state|component|node|entity|relationship)(?:\s+\S+)?)/i);
      if (!keywordMatch) return null;
      // Extract the keyword (without the id)
      var kw2 = keywordMatch[1];
      // The keyword might include the id (e.g. "class Animal") — strip it.
      var kwTokens = kw2.split(/\s+/);
      var schemaKeywords = {
        'abstract class': true, 'class': true, 'interface': true, 'enum': true,
        'state': true, 'component': true, 'node': true,
        'entity': true, 'weak entity': true, 'relationship': true, 'identifying relationship': true
      };
      // Try 2-word, then 1-word, both lowercase
      var twoWord = kwTokens.length >= 2 ? (kwTokens[0] + ' ' + kwTokens[1]).toLowerCase() : null;
      var oneWord = kwTokens[0].toLowerCase();
      var keyword;
      if (twoWord && schemaKeywords[twoWord]) keyword = kwTokens[0] + ' ' + kwTokens[1];
      else if (schemaKeywords[oneWord]) keyword = kwTokens[0];
      else return null;
      // Detect any trailing tokens (stereotype, color, dashed, etc.) after the id.
      var afterIdRe = new RegExp('^' + keyword.replace(/\s+/g, '\\s+') + '\\s+(?:"[^"]+"\\s+as\\s+\\S+|\\S+(?:\\s+as\\s+\\S+)?)\\s*(.*)$', 'i');
      var aft = t.match(afterIdRe);
      var trailing = aft && aft[1] ? ' ' + aft[1] : '';
      return keyword + ' ' + quotedLbl + ' as ' + id + trailing;
    }
    /**
     * Inline-edit a sequence-diagram fragment label (the `alt [cond]` /
     * `loop [cond]` / `else [cond]` text on the wrapper).
     */
    // The fragment.update fields that give the source line `lineIdx`, the opener of a `kind` fragment
    // or an `else` line, the guard `text`: the fragment opened there, or the fragment the else line
    // belongs to (null when it belongs to none).
    function fragmentGuardLineEdit(lineIdx, kind, text) {
      if (kind !== 'else') return { ref: 'frag:' + lineIdx, operator: kind, guard: { branch: null, text: text } };
      var owner = adapter.contents().fragments.map(classicFragmentRange).find(function (range) {
        return range.branches.some(function (branch) { return branch.lineIdx === lineIdx; });
      });
      return { ref: owner ? owner.id : null, operator: null, guard: { branch: lineIdx, text: text } };
    }
    function selectAll() {
      var svg = output.querySelector('svg');
      if (!svg) return;
      var layer = svg.querySelector('.uml-pg-edit-layer');
      if (!layer) return;
      // Every hit target, by id: a box as a node, a line as a route; the last one met is the primary.
      var kinds = Object.create(null);
      Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-edit-hitbox')).forEach(function (rect) {
        var id = rect.getAttribute('data-layout-id');
        if (id) kinds[id] = 'node';
      });
      Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-edge-hitbox')).forEach(function (line) {
        var id = line.getAttribute('data-layout-id');
        if (id) kinds[id] = 'route';
      });
      var keys = Object.keys(kinds);
      selectedLayout.clear();
      keys.forEach(function (id) { selectedLayout.toggle({ id: id, kind: kinds[id] }); });
      // Mirror to UI without the side effects of setSelectedLayoutId reset.
      Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-edit-hitbox')).forEach(function (rect) {
        rect.classList.add('is-selected');
      });
      Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-edge-hitbox')).forEach(function (line) {
        line.classList.add('is-selected');
      });
      if (resetOneBtn) resetOneBtn.disabled = selectionSize() !== 1;
      host.onSelectionChange(selection());
      announce('Selected ' + keys.length + ' item' + (keys.length === 1 ? '' : 's') + '.', false);
    }
    /**
     * Duplicate every currently selected node. Each duplicate is a clone of
     * the source declaration line with its id renamed to a fresh unique one
     * and its position offset by (20, 20). Routes and fragments in the
     * selection are skipped — duplicating a relation in isolation usually
     * isn't what the user wants. The duplicates become the new selection.
     */
    function duplicateSelected() {
      if (!selectionSize()) return;
      var nodeEntries = selectedLayout.all()
        .filter(function (selected) { return selected.kind === 'node'; })
        .map(function (selected) { return selected.id; });
      if (!nodeEntries.length) {
        announce('Nothing to duplicate. Select an element first.', false);
        return;
      }
      var verdict = adapter.apply(buildOperation('element.duplicate',
        { refs: nodeEntries, offset: { x: 20, y: 20 }, scope: 'selection' },
        { positions: originalsDrawnPositions(nodeEntries) }, null));
      if (!verdict.ok) {
        announce(verdict.message, false);
        return;
      }
      // Replace selection with the duplicates so the user can immediately
      // arrow-nudge them into place.
      setSelectedLayoutId(null);
      verdict.select.ids.forEach(function (id, idx) {
        setSelectedLayoutId(id, 'node', { extend: idx > 0 });
      });
      announce(verdict.message, false);
    }
    function nudgeElement(id, dx, dy) {
      var svg = output.querySelector('svg');
      if (!svg) return;
      var editables = findEditableElements(svg);
      var positions = collectPositions(editables);
      if (!positions[id]) return;
      var movedItem = editables.find(function (e) { return e.id === id; }) || null;
      var nudged = {};
      nudged[id] = { x: positions[id].x + dx, y: positions[id].y + dy };
      // Keyboard moves follow the same nesting rules as pointer drags.
      var nudge = layoutSetOperation(svg, {
        positions: nudged,
        routes: [],
        drawnPositions: positions,
        moved: movedItem ? movedBoxesOf({ item: movedItem, box: movedItem.box, groupItems: null }) : [],
        delta: { x: dx, y: dy },
        connectedRoutes: movedItem ? collectConnectedRoutes(svg, id, movedItem) : [],
        undoKey: 'nudge:' + id
      });
      // The nudged element is selected once it is drawn again; a refused nudge selects nothing.
      var awaitingBefore = selectWhenDrawn({ id: id, kind: 'node' });
      var verdict = adapter.apply(nudge);
      if (!verdict.ok) {
        selectWhenDrawn(awaitingBefore);
        announce(verdict.message, false);
        return;
      }
      // The rebuilt target is ready now; avoid stealing a later focus choice.
      focusLayoutTarget(id);
    }

    return {
      link: function () {
        collectConnectedRoutes = kit.collectConnectedRoutes;
        collectPositions = kit.collectPositions;
        shiftPersistedRouteEndpoints = kit.shiftPersistedRouteEndpoints;
      },
      members: {
        activationBarSlots: activationBarSlots,
        activationNudge: activationNudge,
        activityNodeInfoForId: activityNodeInfoForId,
        addDiagramStarter: addDiagramStarter,
        addElementWithoutCanvas: addElementWithoutCanvas,
        addEmptyElement: addEmptyElement,
        addFragmentElseBranch: addFragmentElseBranch,
        addPortIntoComponent: addPortIntoComponent,
        addSequenceParticipant: addSequenceParticipant,
        addSequenceRelationAtY: addSequenceRelationAtY,
        addSequenceSingleMessage: addSequenceSingleMessage,
        addSequenceStarterPair: addSequenceStarterPair,
        announce: announce,
        buildOperation: buildOperation,
        changeFragmentBranchCondition: changeFragmentBranchCondition,
        changeFragmentCondition: changeFragmentCondition,
        changeFragmentKind: changeFragmentKind,
        commitWrap: commitWrap,
        connectWithSelectedRelationTool: connectWithSelectedRelationTool,
        createActivationBar: createActivationBar,
        deleteSelected: deleteSelected,
        documentType: documentType,
        drawnPositions: drawnPositions,
        duplicateElement: duplicateElement,
        duplicateSelected: duplicateSelected,
        fragmentForMessageLine: fragmentForMessageLine,
        fragmentGuardLineEdit: fragmentGuardLineEdit,
        handleHitboxClickForAnchoredNoteTool: handleHitboxClickForAnchoredNoteTool,
        handleHitboxClickForRelation: handleHitboxClickForRelation,
        handleHitboxClickForSequenceElementTool: handleHitboxClickForSequenceElementTool,
        invertRelationDirection: invertRelationDirection,
        layoutSetOperation: layoutSetOperation,
        moveFragmentBy: moveFragmentBy,
        moveSequenceFragmentToY: moveSequenceFragmentToY,
        moveSequenceMessageBy: moveSequenceMessageBy,
        moveSequenceMessageToBranch: moveSequenceMessageToBranch,
        moveSequenceMessageToY: moveSequenceMessageToY,
        movedBoxesOf: movedBoxesOf,
        nudgeElement: nudgeElement,
        placeElementAt: placeElementAt,
        relationAddFacts: relationAddFacts,
        relationInfoForRouteId: relationInfoForRouteId,
        relationLineMatchForRouteId: relationLineMatchForRouteId,
        renameActivityElement: renameActivityElement,
        renameElement: renameElement,
        replaceLineForElementId: replaceLineForElementId,
        replaceRelationLine: replaceRelationLine,
        replaceVirtualNoteText: replaceVirtualNoteText,
        rewireRelationEndpoint: rewireRelationEndpoint,
        routeIdForSourceLine: routeIdForSourceLine,
        routeLayoutSetOperation: routeLayoutSetOperation,
        selectAll: selectAll,
        selectedRelationToolSpec: selectedRelationToolSpec,
        setActivationBarSlots: setActivationBarSlots,
        setActiveTool: setActiveTool,
        setElementLabel: setElementLabel,
        showVerdict: showVerdict,
        toolState: toolState,
        unwrapFragment: unwrapFragment,
        virtualNoteText: virtualNoteText
      }
    };
  }

  return { createClassicCommands: createClassicCommands, createCommands: createCommands, buildOperationOf: buildOperationOf, joiningPreviousStep: joiningPreviousStep };
});
