(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return { actionsShared: require('./c4-editor-actions-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.actionsFields = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // The relationship-fields builder (Ruling 6) of the shared commands: the one set of relationship fields that the
  // anchored relationship form (c4-editor-actions-relationship-form.js) and the inspector place.

  // The connectors a relationship can have (spec §4.6), each with the one-line meaning the select shows.
  const CONNECTOR_LABELS = {
    call: 'Call (asks and waits for the answer)',
    message: 'Message (sent through a queue to one receiver)',
    event: 'Event (announced to any subscriber)',
    stream: 'Stream (a continuous sequence of records)',
    'shared-data': 'Shared data (both use the same stored data)',
  };
  const SEVERITY_WORDS = { error: 'Error', warning: 'Warning', info: 'Suggestion' };
  const SEVERITY_ORDER = ['error', 'warning', 'info'];

  function mostSevere(problems) {
    return SEVERITY_ORDER.find((severity) => problems.some((problem) => problem.severity === severity)) || null;
  }

  /**
   * Builds the fields of a relationship: description (with its sentence frame and the "Reads as:" preview),
   * technology, and connector. `dom`, `ids`, and whether sentence `frames` show come from the actions. `name` makes
   * the ids unique in the editor; `values` fills the fields; `onChange(field, values)` runs when a field's value is
   * committed. Returns `{ element, inputs, getValues, setValues, setEnds, validate, showDiagnostics,
   * showLocalProblem, focus }`; the caller places `element`, applies the values, and removes `element` when done
   * (its listeners go with it).
   */
  function buildRelationshipFields({ dom, ids, frames }, { name, sourceName, targetName, values = {}, onChange = null }) {
    const { RELATIONSHIP_FIELDS, DEFAULT_CONNECTOR, sentence } = editorParts().actionsShared;
    const id = (part) => ids(`${name}-${part}`);
    const ends = { source: sourceName, target: targetName };
    const problems = { local: [], diagnostics: [] };
    const inputs = {
      description: dom.el('input', { type: 'text', id: id('description'), class: 'c4-editor__input', autocomplete: 'off' }),
      technology: dom.el('input', { type: 'text', id: id('technology'), class: 'c4-editor__input', autocomplete: 'off' }),
      connector: dom.el('select', { id: id('connector'), class: 'c4-editor__select' },
        Object.entries(CONNECTOR_LABELS).map(([value, label]) => dom.el('option', { value, text: label }))),
    };
    const problemTexts = {};
    const descriptionHint = dom.el('p', { id: id('description-hint'), class: 'c4-editor__field-hint' });
    const previewText = dom.el('span', { class: 'c4-editor__relationship-preview-text' });
    const preview = dom.el('p', { id: id('preview'), class: 'c4-editor__relationship-preview' },
      [dom.el('span', { class: 'c4-editor__relationship-preview-label', text: 'Reads as:' }), ' ', previewText]);
    // The sentence frame is a switchable scaffold (spec §9.3); the technology hint is an instruction and stays.
    const hints = {
      description: frames ? descriptionHint : null,
      technology: dom.el('p', { id: id('technology-hint'), class: 'c4-editor__field-hint',
        text: 'How the request travels, such as JSON/HTTPS. Name it when the relationship crosses from one container to another.' }),
      connector: null,
    };
    const labels = { description: 'Description', technology: 'Technology', connector: 'Connector' };
    const element = dom.el('div', { class: 'c4-editor__fields c4-editor__relationship-fields' }, RELATIONSHIP_FIELDS.map((field) => {
      problemTexts[field] = dom.el('p', { id: id(`${field}-problem`), class: 'c4-editor__field-problem', hidden: true });
      const describedBy = [hints[field] && hints[field].id, field === 'description' ? preview.id : null, problemTexts[field].id];
      inputs[field].setAttribute('aria-describedby', describedBy.filter(Boolean).join(' '));
      return dom.el('div', { class: 'c4-editor__field' }, [
        dom.el('label', { for: inputs[field].id, class: 'c4-editor__field-label', text: labels[field] }),
        hints[field],
        inputs[field],
        problemTexts[field],
        field === 'description' ? preview : null,
      ]);
    }));

    function getValues() {
      return { description: inputs.description.value.trim(), technology: inputs.technology.value.trim(), connector: inputs.connector.value };
    }

    function setValues(next) {
      setControl(inputs.description, next.description || '');
      setControl(inputs.technology, next.technology || '');
      const connector = next.connector || DEFAULT_CONNECTOR;
      if (![...inputs.connector.options].some((option) => option.value === connector)) {
        inputs.connector.appendChild(dom.el('option', { value: connector, text: connector }));
      }
      setControl(inputs.connector, connector);
      refreshText();
    }

    function setEnds(source, target) {
      ends.source = source;
      ends.target = target;
      refreshText();
    }

    function refreshText() {
      const { description, technology } = getValues();
      descriptionHint.textContent = `Say what ${ends.source} asks ${ends.target} for, starting with a verb: 'requests tuition charges from'.`;
      previewText.textContent = sentence(ends.source, description, ends.target, technology);
    }

    /** Checks what the core would refuse; shows the problems and returns whether there are none. */
    function validate({ requireDescription = true } = {}) {
      problems.local = requireDescription && getValues().description === ''
        ? [{ field: 'description', severity: 'error',
          message: `Describe what ${ends.source} asks ${ends.target} for, starting with a verb, such as 'requests tuition charges from'.` }]
        : [];
      render();
      if (problems.local.length > 0) inputs[problems.local[0].field].focus();
      return problems.local.length === 0;
    }

    function showLocalProblem(field, message) {
      problems.local = [{ field, severity: 'error', message: message.replace(/^Error: /, '') }];
      render();
      inputs[field].focus();
    }

    /** Shows diagnostics (`{ field, severity, message }`, as `relationshipDiagnostics` gives) beside their fields. */
    function showDiagnostics(diagnostics) {
      problems.diagnostics = diagnostics;
      render();
    }

    function render() {
      RELATIONSHIP_FIELDS.forEach((field) => {
        const found = problems.local.concat(problems.diagnostics).filter((problem) => problem.field === field);
        const text = problemTexts[field];
        text.textContent = found.map((problem) => `${SEVERITY_WORDS[problem.severity]}: ${problem.message}`).join(' ');
        text.hidden = found.length === 0;
        SEVERITY_ORDER.forEach((severity) => text.classList.toggle(`c4-editor__field-problem--${severity}`,
          mostSevere(found) === severity));
        if (found.some((problem) => problem.severity === 'error')) inputs[field].setAttribute('aria-invalid', 'true');
        else inputs[field].removeAttribute('aria-invalid');
      });
    }

    RELATIONSHIP_FIELDS.forEach((field) => {
      inputs[field].addEventListener('input', () => {
        if (problems.local.some((problem) => problem.field === field)) {
          problems.local = problems.local.filter((problem) => problem.field !== field);
          render();
        }
        refreshText();
      });
      if (onChange) inputs[field].addEventListener('change', () => onChange(field, getValues()));
    });
    setValues(values);

    return {
      element,
      inputs,
      getValues,
      setValues,
      setEnds,
      validate,
      showDiagnostics,
      showLocalProblem,
      focus: (field = 'description') => inputs[field].focus(),
    };
  }

  function setControl(control, value) {
    if (control.value !== value) control.value = value;
  }

  return { buildRelationshipFields };
});
