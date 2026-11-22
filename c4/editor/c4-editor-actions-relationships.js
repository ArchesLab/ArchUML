(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { actionsShared: require('./c4-editor-actions-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.actionsRelationships = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // Relationship commands (spec §9.2), a unit of the shared commands (c4-editor-actions.js): add, update, delete,
  // Move to… for one end, a relationship's diagnostics by field for its forms, the quick-fix registry (Ruling 20), and
  // the relationship's context menus. The anchored relationship form is in c4-editor-actions-relationship-form.js.

  // Quick fixes are editor commands keyed by rule id (Ruling 20); the core sets `fix: null` on every diagnostic.
  const QUICK_FIXES = {
    'xlevel/unreceived': { label: 'Choose which part receives it', end: 'target' },
    'xlevel/unsent': { label: 'Choose which part sends it', end: 'source' },
  };

  /** The relationship commands. `actions` is the shared context of createActions (state, menus, reading the model, results). */
  function createRelationshipCommands(actions) {
    const { state, menus, model, nameOf, relationshipOf, readOnlyReason, missingElement, missingRelationship, succeed, refuse,
      dispatch, unopened, finish } = actions;
    const { DEFAULT_CONNECTOR, elementName, namesakeNotes, areNested, childrenFirst, startsWith, relationshipAtPath,
      diagnosticField, endsProblem, relationshipMoveProblem, relationshipMoveBatch, changedFields, sentence, relationshipTitle,
      relationshipPhrase, modelWideWording } = editorParts().actionsShared;

    /**
     * Adds a relationship as one undo step. `wording: 'model-wide'` says that it is added to the model and appears in
     * the C4 views of both elements (a canvas of a UML view, UML-view editing spec §5.1). Resolves `{ ok, relationshipId }`.
     */
    function addRelationship({ sourceId, targetId, description, technology = '', connector = DEFAULT_CONNECTOR }, { wording = null } = {}) {
      const problem = readOnlyReason() || missingElement(sourceId) || missingElement(targetId);
      if (problem) return refuse(problem);
      const [source, target] = [nameOf(sourceId), nameOf(targetId)];
      const words = wording === 'model-wide' ? modelWideWording.relationshipAddition(source, description, target, technology)
        : { message: `Added: ${sentence(source, description, target, technology)}.`, label: `Add a relationship from ${source}` };
      const result = dispatch({ op: 'addRelationship', sourceId, targetId, description, technology: technology || null, connector }, words.label);
      return result.ok ? succeed(words.message, { relationshipId: result.selection.relationshipId }) : result;
    }

    /** Writes the `changes` (description, technology, connector; empty text removes a field) as one undo step. */
    function updateRelationship(relationshipId, changes) {
      const relationship = relationshipOf(relationshipId);
      const problem = readOnlyReason() || (relationship ? null : missingRelationship(relationshipId));
      if (problem) return refuse(problem);
      const written = changedFields(relationship, changes);
      if (Object.keys(written).length === 0) return { ok: true, unchanged: true };
      const label = `Edit ${relationshipPhrase(model(), relationship)}`;
      const result = dispatch(Object.assign({ op: 'updateRelationship', relationshipId }, written), label);
      return result.ok ? succeed(`Updated ${relationshipPhrase(model(), relationshipOf(relationshipId))}.`) : result;
    }

    /** Why a new relationship from `sourceId` cannot go to `targetId` (an error message), or null when it can. */
    function newRelationshipProblem(sourceId, targetId) {
      const problem = endsProblem(model(), sourceId, targetId);
      return problem ? problem.message : null;
    }

    /** Deletes a relationship as one undo step; `wording` as for addRelationship. */
    function deleteRelationship(relationshipId, { wording = null } = {}) {
      const relationship = relationshipOf(relationshipId);
      const problem = readOnlyReason() || (relationship ? null : missingRelationship(relationshipId));
      if (problem) return refuse(problem);
      const phrase = relationshipPhrase(model(), relationship);
      const words = wording === 'model-wide' ? modelWideWording.relationshipDeletion(phrase)
        : { message: `Deleted ${phrase}.`, label: `Delete ${phrase}` };
      const result = dispatch({ op: 'removeRelationship', relationshipId }, words.label);
      return result.ok ? succeed(words.message) : result;
    }

    /**
     * The elements one end of a relationship can move to (spec §9.2 "Move a relationship"): `{ source, target }`,
     * each in the model's order with the moved end's own children first, each `{ id, name, unavailable, note }`. An
     * element the relationship cannot connect (the other end, or one nested with it) is left out; one that would
     * duplicate a declared relationship stays, unavailable, with the reason.
     */
    function relationshipMoveCandidates(relationshipId) {
      const relationship = relationshipOf(relationshipId);
      if (!relationship) return { source: [], target: [] };
      const current = model();
      const candidatesFor = (end) => {
        const movingId = end === 'source' ? relationship.sourceId : relationship.targetId;
        const fixedId = end === 'source' ? relationship.targetId : relationship.sourceId;
        return childrenFirst(current, movingId)
          .filter((id) => id !== movingId && id !== fixedId && !areNested(current, id, fixedId))
          .map((id) => {
            const ends = end === 'source' ? [id, fixedId] : [fixedId, id];
            const problem = relationshipMoveProblem(current, relationship, ends[0], ends[1]);
            return { id, name: elementName(current, id), unavailable: problem ? problem.message : null,
              note: problem && problem.code === 'duplicate' ? 'already related' : null };
          });
      };
      return { source: candidatesFor('source'), target: candidatesFor('target') };
    }

    /**
     * Moves one end of a relationship (`{ sourceId }` or `{ targetId }`), keeping its description, technology,
     * connector, requested responsibility, choices, and uses, as one splice and one undo step; the moved
     * relationship ends up selected, so the inspector shows its form.
     */
    function moveRelationship(relationshipId, ends = {}) {
      const relationship = relationshipOf(relationshipId);
      const problem = readOnlyReason() || (relationship ? null : missingRelationship(relationshipId));
      if (problem) return refuse(problem);
      const sourceId = ends.sourceId || relationship.sourceId;
      const targetId = ends.targetId || relationship.targetId;
      if (sourceId === relationship.sourceId && targetId === relationship.targetId) return { ok: true, unchanged: true, relationshipId };
      const current = model();
      const moveProblem = relationshipMoveProblem(current, relationship, sourceId, targetId);
      if (moveProblem) return refuse(moveProblem.message, moveProblem.code);
      const plan = relationshipMoveBatch(state.getDesign(), relationship, sourceId, targetId);
      if (plan.error) return refuse(`Error: ${plan.message}.`, plan.error);
      const title = relationshipTitle(current, relationship);
      const result = dispatch(plan.command, `Move ${title}`);
      if (!result.ok) return result;
      return succeed(`Moved ${title}: now from ${nameOf(sourceId)} to ${nameOf(targetId)}.`,
        { relationshipId: result.selection.relationshipId });
    }

    // ---- Diagnostics for forms ---------------------------------------------------------------

    /** The released diagnostics of a relationship as `{ field, severity, message, rule }`, by the field they concern. */
    function relationshipDiagnostics(relationshipId) {
      const relationship = relationshipOf(relationshipId);
      if (!relationship) return [];
      return state.getDiagnostics()
        .filter((diagnostic) => Array.isArray(diagnostic.path) && startsWith(diagnostic.path, relationship.path))
        .map((diagnostic) => ({ field: diagnosticField(diagnostic, relationship), severity: diagnostic.severity,
          message: diagnostic.message, rule: diagnostic.rule }))
        .filter((problem) => problem.field !== null);
    }

    // ---- Quick fixes -------------------------------------------------------------------------

    /**
     * The editor command that fixes `diagnostic`, as `{ label, apply(placement) }`, or null. `apply` takes where to
     * open (`anchor` or `point`) and `returnFocus`.
     */
    function quickFixFor(diagnostic) {
      const fix = QUICK_FIXES[diagnostic.rule];
      const current = model();
      const relationship = fix && current && Array.isArray(diagnostic.path) ? relationshipAtPath(current, diagnostic.path) : null;
      if (!relationship) return null;
      return {
        label: fix.label,
        apply: (placement) => openRelationshipMoveMenu(relationship.id, Object.assign({}, placement, { focusEnd: fix.end })),
      };
    }

    // ---- Menus -------------------------------------------------------------------------------

    /** The context menu of a relationship: Move to… and Delete (spec §9.2). */
    function openRelationshipMenu(relationshipId, placement = {}) {
      const relationship = relationshipOf(relationshipId);
      if (!relationship) return unopened(missingRelationship(relationshipId));
      const reason = readOnlyReason();
      const current = model();
      const [source, target] = [elementName(current, relationship.sourceId), elementName(current, relationship.targetId)];
      const undescribed = relationship.description === null
        ? `Error: Describe what ${source} asks ${target} for first; moving it keeps the description.`
        : null;
      const items = [
        { label: 'Move to…', unavailable: reason || undescribed,
          run: (context) => openRelationshipMoveMenu(relationshipId, Object.assign({}, placement, context)) },
        { label: 'Delete', unavailable: reason, run: () => finish(placement, deleteRelationship(relationshipId)) },
      ];
      return menus.open({ label: `Relationship from ${source} to ${target}`, groups: [{ label: null, items }], placement, message: reason });
    }

    /**
     * The anchored menu with the groups "New source" and "New target" (spec §9.2); `placement.focusEnd` ('source' |
     * 'target') picks the group that has focus first.
     */
    function openRelationshipMoveMenu(relationshipId, placement = {}) {
      const relationship = relationshipOf(relationshipId);
      if (!relationship) return unopened(missingRelationship(relationshipId));
      const candidates = relationshipMoveCandidates(relationshipId);
      if (candidates.source.length + candidates.target.length === 0) {
        return unopened(`Error: No other element can be the source or target of ${relationshipTitle(model(), relationship)}.`);
      }
      const toItems = (end) => {
        const namesakes = namesakeNotes(model(), candidates[end].map((candidate) => candidate.id));
        return candidates[end].map((candidate) => ({
          label: candidate.name,
          note: [namesakes.get(candidate.id), candidate.note].filter(Boolean).join(' ') || null,
          unavailable: candidate.unavailable,
          run: () => finish(placement, moveRelationship(relationshipId, { [`${end}Id`]: candidate.id })),
        }));
      };
      const groups = [{ label: 'New source', items: toItems('source') }, { label: 'New target', items: toItems('target') }];
      return menus.open({
        label: `Move ${relationshipTitle(model(), relationship)} to a new source or target`,
        groups,
        placement,
        focusGroup: placement.focusEnd === 'target' ? 1 : 0,
      });
    }

    return {
      addRelationship, updateRelationship, newRelationshipProblem, deleteRelationship, relationshipMoveCandidates, moveRelationship,
      relationshipDiagnostics, quickFixFor, openRelationshipMenu, openRelationshipMoveMenu,
    };
  }

  return { createRelationshipCommands };
});
