(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.selection) parts.selection = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The selection set of one session (UML-view editing spec §2.2, §3.3; plan Task 22): the drawn things the learner
  // has selected, each as a reference `{ id, kind }` (kind: 'node', 'route', 'fragment', or 'activation'), and the
  // primary one, the latest selected, which the Properties pane follows. It holds state only; the session shows it.

  /** A new, empty selection. */
  function createSelection() {
    // The selected ids with their kinds, in the order they were selected.
    var kinds = Object.create(null);
    var primaryRef = null;

    function refOf(id) { return { id: id, kind: kinds[id] }; }
    function add(ref) {
      kinds[ref.id] = ref.kind;
      primaryRef = refOf(ref.id);
    }
    function clear() {
      for (var id in kinds) delete kinds[id];
      primaryRef = null;
    }

    return {
      /** The primary reference, or null when nothing is selected. */
      primary: function () { return primaryRef ? refOf(primaryRef.id) : null; },
      /** Every selected reference, in the order they were selected. */
      all: function () { return Object.keys(kinds).map(refOf); },
      /** Selects `ref` alone (null: nothing). */
      set: function (ref) {
        clear();
        if (ref) add(ref);
      },
      /**
       * Adds `ref` and makes it the primary, or removes it when its id is selected; removing the primary makes the
       * latest selected of the rest the primary.
       */
      toggle: function (ref) {
        if (kinds[ref.id] === undefined) {
          add(ref);
          return;
        }
        delete kinds[ref.id];
        if (primaryRef && primaryRef.id === ref.id) {
          var ids = Object.keys(kinds);
          primaryRef = ids.length ? refOf(ids[ids.length - 1]) : null;
        }
      },
      clear: clear,
      /** Whether `ref.id` is selected, and when `ref.kind` is given, selected as that kind. */
      has: function (ref) {
        var kind = kinds[ref.id];
        return kind !== undefined && (ref.kind == null || ref.kind === kind);
      }
    };
  }

  return { createSelection: createSelection };
});
