(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return {
        inspectorShared: require('./c4-editor-inspector-shared.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorChoices = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // Design choices and the decisions that affect an element (spec §9.1), built from the inspector's kit
  // (c4-editor-inspector-kit.js): the chosen technology, the alternatives and the reason, styles, tactics, and the
  // patterns (read-only here) of an element or a relationship, and the element form's "Decisions affecting it".

  /**
   * The design choices and decisions. `inspector` is the inspector's shared context: the kit and `dom`. Returns
   * `choicesBody(choices, path, target)` and `decisionsSection(model, current)`.
   */
  function createChoicesSections(inspector) {
    const { dom, field, formSection, textList, run } = inspector;
    const { TEXT, compact } = editorParts().inspectorShared;

    /** The choices form of an element or a relationship (`target` is `{ elementId }` or `{ relationshipId }`). */
    function choicesBody(choices, path, target) {
      const current = choices || { technology: null, styles: [], patterns: [], tactics: [] };
      const technology = current.technology || { chosen: null, alternatives: [], because: null, decision: null };
      const write = (next) => run(Object.assign({ op: 'setChoices', choices: authoredChoices(next) }, target), 'Edit design choices');
      const withTechnology = (changes) => Object.assign({}, current, { technology: Object.assign({}, technology, changes) });
      const textValue = (value) => (value.trim() === '' ? null : value.trim());
      return [
        field({ key: 'choice-chosen', label: 'Chosen technology', value: technology.chosen, path: path.concat('technology', 'chosen'),
          onCommit: (value) => write(withTechnology({ chosen: textValue(value) })) }),
        textList({ key: 'choice-alternatives', label: 'Alternatives considered', itemName: 'alternative', items: technology.alternatives,
          path: path.concat('technology', 'alternatives'), write: (items) => write(withTechnology({ alternatives: items })) }),
        field({ key: 'choice-because', label: 'Because', value: technology.because, path: path.concat('technology', 'because'),
          onCommit: (value) => write(withTechnology({ because: textValue(value) })) }),
        textList({ key: 'choice-styles', label: 'Architectural styles', itemName: 'style', items: current.styles,
          path: path.concat('styles'), write: (items) => write(Object.assign({}, current, { styles: items })) }),
        textList({ key: 'choice-tactics', label: 'Tactics', itemName: 'tactic', items: current.tactics,
          path: path.concat('tactics'), write: (items) => write(Object.assign({}, current, { tactics: items })) }),
        current.patterns.length > 0 ? dom.el('div', { class: 'c4-editor__field' }, [
          dom.el('p', { class: 'c4-editor__field-label', text: 'Patterns' }),
          dom.el('ul', { class: 'c4-editor__plain-list' }, current.patterns.map((pattern) => dom.el('li', { text: patternLabel(pattern) }))),
          dom.el('p', { class: 'c4-editor__field-hint', text: TEXT.patternsNote }),
        ]) : null,
      ];
    }

    function decisionsSection(model, current) {
      const affecting = [...model.decisions.values()].filter((decision) => decision.affects.includes(current.id));
      return formSection('decisions', 'Decisions affecting it', affecting.length === 0
        ? dom.el('p', { class: 'c4-editor__field-hint', text: `No decision names ${current.name} yet.` })
        : dom.el('ul', { class: 'c4-editor__plain-list' }, affecting.map((decision) => dom.el('li', {}, [
          dom.el('span', { class: 'c4-editor__decision-title',
            text: `${decision.title || decision.id}${decision.status ? ` (${decision.status})` : ''}` }),
          decision.decision ? [': ', decision.decision] : null,
        ]))));
    }

    /**
     * Design choices as written back by `setChoices`: no null fields and no empty lists, and a pattern with only a
     * pattern and a role in the shorthand "Pattern: Role", so untouched patterns keep the form they are usually written in.
     */
    function authoredChoices(choices) {
      const written = {};
      const technology = choices.technology ? compact(choices.technology) : null;
      if (technology) written.technology = technology;
      if (choices.styles.length > 0) written.styles = choices.styles;
      if (choices.patterns.length > 0) {
        written.patterns = choices.patterns.map((pattern) => (pattern.instance === null && pattern.decision === null && pattern.role !== null
          ? `${pattern.pattern}: ${pattern.role}` : compact(pattern)));
      }
      if (choices.tactics.length > 0) written.tactics = choices.tactics;
      return Object.keys(written).length > 0 ? written : null;
    }

    return { choicesBody, decisionsSection };
  }

  function patternLabel(pattern) {
    const role = pattern.role ? `: ${pattern.role}` : '';
    const instance = pattern.instance ? ` (${pattern.instance})` : '';
    return `${pattern.pattern}${role}${instance}`;
  }

  return { createChoicesSections };
});
