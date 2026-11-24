(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return {
        inspectorShared: require('./c4-editor-inspector-shared.js'),
        inspectorScenarios: require('./c4-editor-inspector-scenarios.js'),
        inspectorDeployment: require('./c4-editor-inspector-deployment.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorRecords = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // ---- Supplementary forms (spec §9.1) ----------------------------------------------------------
  //
  // Scenarios, deployment environments and nodes, the members of code elements, and the top-level records. They are
  // built from the element form's kit (fields, sections, lists, locks, commands), so every form shares one way to label,
  // lock, lint, and commit a field; nothing here reads the inspector's DOM except through that kit. Scenarios and
  // deployment have their own files (c4-editor-inspector-scenarios.js, c4-editor-inspector-deployment.js); this one
  // holds the members of code elements and the forms of decisions, requirements, groups, and custom views.

  const DECISION_STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'];
  const DECISION_KEYS = ['title', 'status', 'context', 'decision', 'alternatives', 'consequences', 'affects', 'supersedes', 'date'];
  const REQUIREMENT_KINDS = ['functional', 'quality', 'constraint'];
  const VIEW_DIRECTIONS = [{ value: '', label: 'Down (the default)' }, { value: 'right', label: 'Right' }];
  const VIEW_ANNOTATIONS = ['patterns', 'styles', 'tactics', 'interfaces'];

  /**
   * The forms for everything that is not an element or a relationship. `kit` is the inspector's shared context: the
   * form kit, `state`, `dom`, `announce`, and `splices` (the writer for the edits the core has no command for yet).
   * Returns `formFor(model, selection)` (the form of a scenario, environment, node, decision, requirement, group, or
   * view selection, or null) and `membersSection(model, element)` (the Members of a code element).
   */
  function createRecordForms(kit) {
    const { state, dom, field, formSection, button, textList, run, problem, form, gone, checkboxGroup, splices } = kit;
    const { setOrDelete, listOrNull, textValue, withCurrent, elementChoices, capitalize } = editorParts().inspectorShared;
    const { scenarioForm } = editorParts().inspectorScenarios.createScenarioForms(kit);
    const { environmentForm, nodeForm } = editorParts().inspectorDeployment.createDeploymentForms(kit);

    function formFor(model, selection) {
      if (selection.scenarioId) return scenarioForm(model, selection.scenarioId);
      if (selection.nodeId) return nodeForm(model, selection.environmentId, selection.nodeId);
      if (selection.environmentId) return environmentForm(model, selection.environmentId);
      if (selection.decisionId) return decisionForm(model, selection.decisionId);
      if (selection.requirementId) return requirementForm(model, selection.requirementId);
      if (selection.groupId) return groupForm(model, selection.groupId, selection.scopeId || null);
      if (selection.viewId) return customViewForm(model, selection.viewId);
      return null;
    }

    // ---- Code members --------------------------------------------------------------------------

    /** Members of a code element (spec §4.4, §9.1): attributes and operations as text lists, extends and implements as checkboxes. */
    function membersSection(model, current) {
      const setList = (fieldName) => (items) => run({ op: 'setList', elementId: current.id, field: fieldName, items },
        `Edit the ${fieldName} of ${current.name}`);
      const others = [...model.elements.values()].filter((element) => element.type === 'code' && element.id !== current.id).map((element) => element.id);
      const references = (fieldName, label) => {
        const chosen = current.code[fieldName];
        return checkboxGroup({ key: `member-${fieldName}`, label, choices: elementChoices(model, withCurrent(others, ...chosen), { byId: true }),
          checked: chosen, path: current.path.concat(fieldName), empty: 'No other code element exists yet.',
          onToggle: (id, on) => setList(fieldName)(on ? chosen.concat(id) : chosen.filter((chosenId) => chosenId !== id)) });
      };
      return formSection('members', 'Members', [
        textList({ key: 'member-attributes', label: 'Attributes', itemName: 'attribute', items: current.code.attributes,
          path: current.path.concat('attributes'), write: setList('attributes') }),
        textList({ key: 'member-operations', label: 'Operations', itemName: 'operation', items: current.code.operations,
          path: current.path.concat('operations'), write: setList('operations') }),
        dom.el('p', { class: 'c4-editor__field-hint', text: 'Write a member as UML does, such as "+ evaluate(student, section): RuleResult".' }),
        references('extends', 'Extends'),
        references('implements', 'Implements'),
      ]);
    }

    // ---- Top-level records ---------------------------------------------------------------------

    function decisionForm(model, decisionId) {
      const decision = model.decisions.get(decisionId);
      if (!decision) return gone('This decision is no longer in the model.');
      const path = decision.path;
      const title = decision.title || decision.id;
      const write = (key) => (value) => splices.write(`Edit the decision ${title}`,
        [(parsed, yaml) => setOrDelete(yaml, parsed, path, key, value, DECISION_KEYS)]);
      const text = (key, label, control = 'input', hint = null) => field({ key: `decision-${key}`, label, control, value: decision[key],
        path: path.concat(key), hint, onCommit: (value) => write(key)(textValue(value)) });
      const otherDecisions = [...model.decisions.values()].filter((other) => other.id !== decision.id);
      return form(`Decision: ${title}`, 'Architecture decision: a consequential choice, its reasons, and what it affects', [
        formSection('decision-basics', 'Decision', dom.el('div', { class: 'c4-editor__fields' }, [
          text('title', 'Title'),
          field({ key: 'decision-status', label: 'Status', control: 'select', value: decision.status || '', path: path.concat('status'),
            choices: [{ value: '', label: 'Not set' }].concat(DECISION_STATUSES.map((status) => ({ value: status, label: capitalize(status) }))),
            onCommit: (value) => write('status')(value || null) }),
          text('context', 'Context', 'textarea', 'The forces that made a decision necessary.'),
          text('decision', 'Decision', 'textarea'),
          textList({ key: 'decision-alternatives', label: 'Alternatives considered', itemName: 'alternative', items: decision.alternatives,
            path: path.concat('alternatives'), write: (items) => write('alternatives')(items.length > 0 ? items : null) }),
          text('consequences', 'Consequences', 'textarea', 'What becomes easier or harder because of it.'),
          text('date', 'Date', 'input', 'Written as year-month-day, such as 2026-11-09.'),
        ])),
        formSection('decision-affects', 'Affects', checkboxGroup({ key: 'decision-affects', label: 'Elements it affects',
          choices: elementChoices(model, withCurrent([...model.elements.keys()], ...decision.affects)), checked: decision.affects,
          path: path.concat('affects'), empty: 'The model has no elements yet.',
          onToggle: (id, on) => write('affects')(listOrNull(on ? decision.affects.concat(id) : decision.affects.filter((chosen) => chosen !== id))) })),
        otherDecisions.length === 0 ? null : formSection('decision-supersedes', 'Supersedes', checkboxGroup({ key: 'decision-supersedes',
          label: 'Decisions it replaces', choices: otherDecisions.map((other) => ({ value: other.id, label: other.title || other.id })),
          checked: decision.supersedes, path: path.concat('supersedes'), empty: '',
          onToggle: (id, on) => write('supersedes')(listOrNull(on ? decision.supersedes.concat(id) : decision.supersedes.filter((chosen) => chosen !== id))) })),
      ]);
    }

    /** A requirement stays the shorthand `id: text` until it gets a kind (spec §4.8). */
    function requirementForm(model, requirementId) {
      const requirement = model.requirements.get(requirementId);
      if (!requirement) return gone('This requirement is no longer in the model.');
      const entry = (text, kind) => (kind ? { text, kind } : text);
      const write = (text, kind, label) => run({ op: 'setTopLevelEntry', section: 'requirements', id: requirement.id, value: entry(text, kind) }, label);
      return form(`Requirement: ${requirement.id}`, 'Requirement: what the system must do or be, traced from responsibilities', [
        formSection('requirement-basics', 'Requirement', dom.el('div', { class: 'c4-editor__fields' }, [
          field({ key: 'requirement-text', label: 'Text', control: 'textarea', value: requirement.text, path: requirement.path,
            onCommit: (value) => (value.trim() === '' ? problem('requirement-text', 'Error: A requirement needs its text.')
              : write(value.trim(), requirement.kind, `Edit the requirement ${requirement.id}`)) }),
          field({ key: 'requirement-kind', label: 'Kind', control: 'select', value: requirement.kind || '', path: requirement.path.concat('kind'),
            choices: [{ value: '', label: 'Not set' }].concat(REQUIREMENT_KINDS.map((kind) => ({ value: kind, label: capitalize(kind) }))),
            onCommit: (value) => write(requirement.text, value || null, `Change the kind of ${requirement.id}`) }),
        ])),
      ]);
    }

    function groupForm(model, groupId, scopeId) {
      const found = model.groups.get(`${scopeId || ''}/${groupId}`);
      if (!found) return gone('This group is no longer in the model.');
      const write = (key) => (value) => splices.write(`Edit the group ${found.name}`, [(parsed, yaml) => setOrDelete(yaml, parsed, found.path, key, value)]);
      const scope = scopeId ? model.elements.get(scopeId) : null;
      return form(`Group: ${found.name}`, scope ? `Group of elements inside ${scope.name}` : 'Group of people and software systems', [
        formSection('group-basics', 'Group', dom.el('div', { class: 'c4-editor__fields' }, [
          field({ key: 'group-name', label: 'Name', value: found.name, path: found.path.concat('name'),
            onCommit: (value) => write('name')(textValue(value)) }),
          field({ key: 'group-description', label: 'Description', control: 'textarea', value: found.description, path: found.path.concat('description'),
            onCommit: (value) => write('description')(textValue(value)) }),
        ])),
      ]);
    }

    function customViewForm(model, viewId) {
      const custom = model.views.get(viewId);
      if (!custom) return gone('This view is no longer in the model.');
      const path = custom.path;
      const title = custom.title || custom.id;
      const write = (key) => (value) => splices.write(`Edit the view ${title}`, [(parsed, yaml) => setOrDelete(yaml, parsed, path, key, value)]);
      const idList = (key) => textList({ key: `view-${key}`, label: capitalize(key), itemName: 'element id', items: custom[key], path: path.concat(key),
        write: (items) => write(key)(listOrNull(items)) });
      return form(`View: ${title}`, 'Custom view: a built-in view with its own title, elements, and options', [
        formSection('view-basics', 'View', dom.el('div', { class: 'c4-editor__fields' }, [
          field({ key: 'view-view', label: 'Based on', value: custom.view, path: path.concat('view'), hint: 'A built-in view, such as components of api.',
            onCommit: (value) => (value.trim() === '' ? problem('view-view', 'Error: Name the built-in view it is based on.') : write('view')(value.trim())) }),
          field({ key: 'view-title', label: 'Title', value: custom.title, path: path.concat('title'), onCommit: (value) => write('title')(textValue(value)) }),
          field({ key: 'view-description', label: 'Description', control: 'textarea', value: custom.description, path: path.concat('description'),
            onCommit: (value) => write('description')(textValue(value)) }),
          field({ key: 'view-direction', label: 'Direction', control: 'select', value: custom.direction === 'right' ? 'right' : '',
            path: path.concat('direction'), choices: VIEW_DIRECTIONS, onCommit: (value) => write('direction')(value || null) }),
          field({ key: 'view-show-title', label: 'Show the title in the diagram', control: 'checkbox', value: custom.showTitle,
            path: path.concat('show_title'), onCommit: (on) => write('show_title')(on ? null : false) }),
          field({ key: 'view-derived', label: 'Show derived relationships', control: 'checkbox', value: custom.derived,
            path: path.concat('derived'), onCommit: (on) => write('derived')(on ? null : false) }),
          checkboxGroup({ key: 'view-annotations', label: 'Annotations', choices: VIEW_ANNOTATIONS.map((value) => ({ value, label: capitalize(value) })),
            checked: custom.annotations, path: path.concat('annotations'), empty: '',
            onToggle: (value, on) => write('annotations')(listOrNull(VIEW_ANNOTATIONS.filter((candidate) => (candidate === value ? on : custom.annotations.includes(candidate))))) }),
          idList('include'),
          idList('exclude'),
          state.getView() === custom.id ? null : button('Open this view', () => state.openView(custom.id), { 'data-c4-focus-key': 'view-open' }),
        ])),
      ]);
    }

    return { formFor, membersSection };
  }

  return { createRecordForms };
});
