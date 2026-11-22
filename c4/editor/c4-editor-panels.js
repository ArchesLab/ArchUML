(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () { return require('./c4-editor-scaffolds.js'); });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.panels = factory(root.ArchUMLC4, function () { return parts.scaffolds; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, scaffolds) {
  'use strict';

  // The editor's bottom panels and the way it presents diagnostics (spec §7.3, §9.1–§9.3): the Problems, Review,
  // Explain, and YAML tabs, the YAML-error banner, and the gate that disables visual commands while the YAML cannot
  // be read. The panels read and change the model only through the state controller; they ask other parts for
  // something (the inspector to focus a field) by selecting through the state, never by touching their DOM.

  const SOURCE_DEBOUNCE_MS = 250;
  const COUNT_ANNOUNCE_DELAY_MS = 1000;
  const SEVERITIES = [
    { severity: 'error', word: 'Error', group: 'Errors', one: 'error', many: 'errors' },
    { severity: 'warning', word: 'Warning', group: 'Warnings', one: 'warning', many: 'warnings' },
    { severity: 'info', word: 'Suggestion', group: 'Suggestions', one: 'suggestion', many: 'suggestions' },
  ];
  const TEXT = {
    tablist: 'Editor panels',
    problemsEmpty: 'The checks found no problems. They test consistency and some completeness, not whether boundaries, owners, or names are right; see Review.',
    hiddenUntilCheck: 'Problems are hidden until you choose Check now.',
    hiddenUntilSubmit: 'Problems are hidden until you submit for review.',
    checkNow: 'Check now',
    submitForReview: 'Submit for review',
    automated: 'Automated checks',
    prompts: 'Questions the checks cannot answer',
    showInside: 'Show inside',
    explainHidden: 'The description stays hidden so that you can predict what is inside first.',
    explainUnreadable: 'Fix the YAML to see the description of this view.',
    source: 'YAML source',
    markers: 'Problems in the YAML',
    goToError: 'Go to error',
  };
  const TABS = [
    { name: 'problems', label: 'Problems' },
    { name: 'review', label: 'Review' },
    { name: 'explain', label: 'Explain' },
    { name: 'yaml', label: 'YAML' },
  ];

  // Human-judgment prompts (spec §9.3 for C4-notation views, §9.5 for interfaces).
  const C4_PROMPTS = Object.freeze([
    'Does each box\'s type match who builds and runs it? Is a data store your team runs drawn as its own software system?',
    'Which element is the only writer of each fact, and the one maker of each decision?',
    'Read each arrow aloud from the element that asks: does it say what is asked, and how it travels where it crosses a container?',
    'Which reader and question is this view for, and which level did you leave out for them?',
    'Does each responsibility keep the meaning of the requirement it traces to?',
  ]);
  const INTERFACE_PROMPTS = Object.freeze([
    'Could a team that never spoke to you call this operation correctly from the description alone?',
    'Which fields carry a quantity or a date; is the unit or format stated, what does it include (tax, fees), and what is it measured against (time zone, coordinate frame)?',
    'Which test would show that both implementations read this field the same way?',
    'Does any name reveal how the provider stores or computes data?',
    'Which operations or fields does no client need?',
    'Can this interface grow without breaking clients (an optional input field, an open list such as add-ons), and which change would need a new version?',
    'Does every term mean the same in every interface it appears in?',
    'For each error, does the client know what to do next?',
  ]);
  const DELIVERY_PROMPT = 'Can a subscriber receive it twice, out of order, or not at all?';
  const TRANSLATION_PROMPT = 'Which formats, units, and terms does it translate?';
  const DELIVERY_STYLES = ['event', 'stream'];
  // The automated results for interfaces under review (spec §9.5): operations without purpose, errors, or examples,
  // and fields without unit, format, or meaning. The labels use the interface form's field names.
  const INTERFACE_GAPS = Object.freeze([
    { rule: 'interface/no-purpose', label: 'Operations without a Purpose', subject: 'operation' },
    { rule: 'interface/no-errors', label: 'Operations without Errors', subject: 'operation' },
    { rule: 'interface/no-example', label: 'Operations without Examples', subject: 'operation' },
    { rule: 'interface/no-unit', label: 'Fields without a Unit', subject: 'field' },
    { rule: 'interface/no-format', label: 'Fields without a Format', subject: 'field' },
    { rule: 'interface/no-meaning', label: 'Fields without a Meaning', subject: 'field' },
  ]);
  const MEANING_CHECKLIST = 'Checklist: fields without a Meaning';

  // Rules whose path names the element or relationship (its collaborator entry) although the problem is one of its
  // fields: the row names that field and Show goes to it.
  const MISSING_FIELD_RULES = {
    'c4/cross-container-technology': 'technology',
    'c4/vague-relationship': 'description',
    'rdd/no-reason': 'description',
    'c4/no-technology': 'technology',
    'c4/technology-tbd': 'technology',
    'c4/no-description': 'description',
    'c4/sparse-description': 'description',
    'c4/generic-name': 'name',
    'c4/duplicate-name': 'name',
    'rdd/manager-name': 'name',
    'rdd/no-responsibility': 'responsibilities',
    'rdd/untyped': 'responsibilities',
  };
  // The inspector's field labels (spec §9.1), and the item names of list fields.
  const FIELD_LABELS = {
    name: 'Name', kind: 'Kind', technology: 'Technology', description: 'Description', external: 'External',
    in_enterprise: 'In enterprise', responsibilities: 'Responsibilities', collaborators: 'Collaborators',
    owns: 'Owns', invariants: 'Invariants', quality: 'Quality', stereotypes: 'Stereotypes', group: 'Group',
    source: 'Source', tags: 'Tags', choices: 'Design choices', provides: 'Provides', attributes: 'Attributes',
    operations: 'Operations', extends: 'Extends', implements: 'Implements', refines: 'Refines',
    requirements: 'Requirements', connector: 'Connector', responsibility: 'Responsibility', uses: 'Uses',
    steps: 'Steps', title: 'Title', hosts: 'Hosts', instances: 'Instances', nodes: 'Nodes',
  };
  const ITEM_LABELS = {
    responsibilities: 'Responsibility', steps: 'Step', owns: 'Owned fact', invariants: 'Invariant',
    quality: 'Quality statement', tags: 'Tag', attributes: 'Attribute', operations: 'Operation',
    stereotypes: 'Stereotype', provides: 'Interface', requirements: 'Requirement', refines: 'Refined responsibility',
  };

  // ---- Diagnostics as the learner reads them (DOM-free) ------------------------------------------------------------

  function severityOf(diagnostic) {
    return SEVERITIES.find((entry) => entry.severity === diagnostic.severity) || SEVERITIES[0];
  }

  /** "Warning: …": the text of a diagnostic in a row, a marker, or a form (spec §9.2). */
  function diagnosticText(diagnostic) {
    return `${severityOf(diagnostic).word}: ${diagnostic.message}`;
  }

  /**
   * Where a diagnostic belongs: `{ selection, fieldPath, place, showName }`. `selection` is what Show selects (an
   * element, relationship, interface, scenario, or environment), or null for a problem that belongs to no part of the
   * model (the YAML itself); `fieldPath` is the YAML path of the field (rules about a missing field point at it);
   * `place` is the visible "Seat Gateway › Technology"; `showName` is the Show button's accessible name.
   */
  function locateDiagnostic(model, diagnostic) {
    const path = diagnostic.path || [];
    const subject = model ? subjectOf(model, diagnostic, path) : null;
    if (subject === null) return yamlPlace(diagnostic, path);
    const missingField = MISSING_FIELD_RULES[diagnostic.rule];
    const fieldPath = missingField && path.length === subject.path.length ? path.concat(missingField) : path;
    const field = fieldLabelOf(fieldPath.slice(subject.path.length));
    return {
      selection: subject.selection,
      fieldPath,
      place: field === null ? subject.place : `${subject.place} › ${field}`,
      showName: field === null ? `Show ${subject.phrase}` : `Show ${field} of ${subject.phrase}`,
    };
  }

  /** The deepest part of the model the diagnostic's path lies in: `{ selection, path, place, phrase }`, or null. */
  function subjectOf(model, diagnostic, path) {
    const relationship = model.relationships.find((candidate) => startsWith(path, candidate.path));
    if (relationship) {
      const source = nameOf(model, relationship.sourceId);
      const target = nameOf(model, relationship.targetId);
      return {
        selection: { relationshipId: relationship.id },
        path: relationship.path,
        place: `${source} › Relationship to ${target}`,
        phrase: `the relationship from ${source} to ${target}`,
      };
    }
    const anInterface = diagnostic.interface ? model.interfaces.get(diagnostic.interface) : null;
    if (anInterface) return namedSubject({ interfaceId: anInterface.id }, anInterface.path, anInterface.name);
    const element = diagnostic.element ? model.elements.get(diagnostic.element) : null;
    if (element) return namedSubject({ elementId: element.id }, element.path, element.name);
    if (path[0] === 'scenarios' && model.scenarios.has(path[1])) {
      const scenario = model.scenarios.get(path[1]);
      return namedSubject({ scenarioId: scenario.id }, scenario.path, scenario.title);
    }
    if (path[0] === 'deployment' && model.environments.has(path[1])) {
      const environment = model.environments.get(path[1]);
      return namedSubject({ environmentId: environment.id }, environment.path, environment.name);
    }
    return null;
  }

  function namedSubject(selection, path, name) {
    return { selection, path, place: name, phrase: name };
  }

  /** A problem in the YAML text itself, located by its line. */
  function yamlPlace(diagnostic, path) {
    const line = diagnostic.range ? diagnostic.range.start.line : null;
    return {
      selection: null,
      fieldPath: path,
      place: line === null ? 'YAML' : `YAML line ${line}`,
      showName: line === null ? null : `Show line ${line} in the YAML`,
    };
  }

  /** "Technology", "Responsibility 1", "Responsibility 1 › Refines", or null for the subject itself. */
  function fieldLabelOf(rest) {
    if (rest.length === 0) return null;
    const [key, index, detail] = rest;
    const label = FIELD_LABELS[key] || capitalized(String(key).replace(/_/g, ' '));
    if (typeof index !== 'number') return label;
    const item = `${ITEM_LABELS[key] || label} ${index + 1}`;
    return typeof detail === 'string' && FIELD_LABELS[detail] ? `${item} › ${FIELD_LABELS[detail]}` : item;
  }

  /**
   * The diagnostics a form shows inline beside the field at `fieldPath` (and the fields inside it), each with its
   * `text` ("Warning: …"). They follow the display mode (none before Check now or Submit for review), and with the
   * `inlineLint` scaffold off only errors remain: a lint hint is a scaffold, an invalid model is not.
   */
  function fieldDiagnostics(state, fieldPath, options) {
    const lint = scaffolds().isScaffoldOn(options, 'inlineLint');
    const model = state.getDesign().model;
    return state.getDiagnostics()
      .filter((diagnostic) => lint || diagnostic.severity === 'error')
      .filter((diagnostic) => startsWith(locateDiagnostic(model, diagnostic).fieldPath, fieldPath))
      .map((diagnostic) => Object.assign({}, diagnostic, { text: diagnosticText(diagnostic) }));
  }

  /** "2 warnings, 6 suggestions": the counts by severity, most severe first, or '' for none. */
  function countSummary(diagnostics) {
    return SEVERITIES
      .map((entry) => [entry, diagnostics.filter((diagnostic) => diagnostic.severity === entry.severity).length])
      .filter(([, count]) => count > 0)
      .map(([entry, count]) => `${count} ${count === 1 ? entry.one : entry.many}`)
      .join(', ');
  }

  // ---- Disabled visual commands (spec §7.3) -----------------------------------------------------------------------

  /** Why visual commands are disabled now ("Fix the YAML error on line 6 first."), or null when they work. */
  function disabledReason(state) {
    const mode = state.getMode();
    if (mode.reason === 'read-only') return 'This model is read-only.';
    if (mode.reason !== 'yaml-errors') return null;
    const line = firstErrorLine(mode.errors);
    return line === null ? 'Fix the YAML errors first.' : `Fix the YAML error on line ${line} first.`;
  }

  function firstErrorLine(errors) {
    const located = errors.find((error) => error.range);
    return located ? located.range.start.line : null;
  }

  /**
   * Gates visual commands: while `disabledReason(state)` names a reason, every gated control is `aria-disabled`,
   * described by the reason, and its activation is stopped before it reaches the control (the reason is announced
   * instead). Controls stay focusable, so the reason stays discoverable. Returns `{ gate(control) → release(),
   * destroy() }`; the toolbar gates its visual commands (Add, Add relationship, palette tiles, Reset layout).
   */
  function createCommandGate(root, { state, dom, ids, announce }) {
    const reasonId = ids('command-gate-reason');
    const reason = dom.el('span', { id: reasonId, hidden: true });
    root.appendChild(reason);
    const controls = new Set();

    function describe(control, text) {
      const tokens = describedBy(control).filter((token) => token !== reasonId);
      if (text) {
        control.setAttribute('aria-disabled', 'true');
        tokens.push(reasonId);
      } else {
        control.removeAttribute('aria-disabled');
      }
      setDescribedBy(control, tokens);
    }

    function refresh() {
      const text = disabledReason(state);
      reason.textContent = text || '';
      controls.forEach((control) => describe(control, text));
    }

    function stopWhileDisabled(event) {
      const text = disabledReason(state);
      if (text === null || ![...controls].some((control) => control.contains(event.target))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (announce) announce(text);
    }

    root.addEventListener('click', stopWhileDisabled, true);
    const unsubscribes = [state.on('mode', refresh), state.on('text', refresh)];
    refresh();

    return {
      gate(control) {
        controls.add(control);
        describe(control, disabledReason(state));
        return function release() {
          controls.delete(control);
          describe(control, null);
        };
      },
      destroy() {
        unsubscribes.forEach((unsubscribe) => unsubscribe());
        root.removeEventListener('click', stopWhileDisabled, true);
        controls.forEach((control) => describe(control, null));
        controls.clear();
        reason.remove();
      },
    };
  }

  // ---- Review prompts (DOM-free) ------------------------------------------------------------------------------------

  /**
   * The human-judgment prompts for a view: the C4 prompts on C4-notation views, and the interface prompts on
   * interface views and while an element with interfaces is selected (delivery for event and stream interfaces,
   * translation for an element that provides one interface and uses another as an interfacer or Adapter).
   */
  function reviewPrompts(model, viewModel, selection) {
    const prompts = viewModel.notation === 'c4' ? C4_PROMPTS.slice() : [];
    const reviewed = interfacesUnderReview(model, viewModel, selection);
    if (reviewed.length === 0) return prompts;
    prompts.push(...INTERFACE_PROMPTS);
    if (reviewed.some((anInterface) => DELIVERY_STYLES.includes(anInterface.style))) prompts.push(DELIVERY_PROMPT);
    const providers = new Set(reviewed.map((anInterface) => anInterface.providerId));
    if ([...providers].some((id) => translates(model, model.elements.get(id)))) prompts.push(TRANSLATION_PROMPT);
    return prompts;
  }

  /** The interfaces the Review panel speaks about: the open interface view's, or the selected interface or element's. */
  function interfacesUnderReview(model, viewModel, selection) {
    if (viewModel.type === 'interface') return [model.interfaces.get(viewModel.scopeId)].filter(Boolean);
    if (viewModel.type !== 'interfaces' && selection && selection.interfaceId) {
      return [model.interfaces.get(selection.interfaceId)].filter(Boolean);
    }
    const element = viewModel.type === 'interfaces' ? model.elements.get(viewModel.scopeId)
      : selection && selection.elementId ? model.elements.get(selection.elementId) : null;
    if (!element) return [];
    return (element.interfaceIds || []).map((id) => model.interfaces.get(id)).filter(Boolean);
  }

  /** An interfacer or Adapter that provides an interface and uses another one: it translates between the two. */
  function translates(model, element) {
    if (!element) return false;
    const adapter = (element.stereotypes || []).includes('interfacer')
      || ((element.choices && element.choices.patterns) || []).some((use) => use.pattern === 'Adapter');
    const own = new Set(element.interfaceIds || []);
    return adapter && model.relationships.some((relationship) => relationship.sourceId === element.id
      && relationship.uses.some((use) => !own.has(use.interfaceId)));
  }

  /**
   * The automated results for the interfaces under review: `[{ label, items }]` for each kind of gap that
   * `diagnostics` show, in INTERFACE_GAPS order; each item names the operation ("submit-plan") or field
   * ("EnrollmentOutcome.units_enrolled", "amount (input of charge)"), after its interface when several are reviewed.
   */
  function interfaceGaps(reviewed, diagnostics) {
    return INTERFACE_GAPS.map((gap) => ({
      label: gap.label,
      items: subjectsOf(reviewed, diagnostics.filter((diagnostic) => diagnostic.rule === gap.rule), gap.subject),
    })).filter((gap) => gap.items.length > 0);
  }

  function subjectsOf(reviewed, diagnostics, subject) {
    const items = diagnostics.flatMap((diagnostic) => {
      const declared = reviewed.find((candidate) => sameId(candidate.id, diagnostic.interface));
      if (!declared) return [];
      const name = subject === 'operation' ? diagnostic.operation : fieldLabel(declared, diagnostic);
      if (!name) return [];
      return [reviewed.length > 1 ? `${name} in ${declared.name}` : name];
    });
    return [...new Set(items)];
  }

  /** "EnrollmentOutcome.units_enrolled" for a field of a type, "amount (input of charge)" for an inline field. */
  function fieldLabel(declared, diagnostic) {
    const rest = (diagnostic.path || []).slice(declared.path.length);
    if (rest[0] === 'types' && rest[2] === 'fields') return `${rest[1]}.${rest[3]}`;
    if (rest[0] === 'operations' && (rest[2] === 'input' || rest[2] === 'output')) return `${rest[3]} (${rest[2]} of ${rest[1]})`;
    return diagnostic.field;
  }

  function sameId(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  }

  // ---- The panels ---------------------------------------------------------------------------------------------------

  /**
   * Builds the tablist and its four panels in `region`, and the YAML-error banner in `deps.bannerRegion` (default:
   * the top of `region`). deps (the mount's part context): `state`, `dom`, `ids`, `host` (`createSourceEditor`,
   * optional), `actions` (optional; its `quickFixFor(diagnostic)` gives a row's quick fix), `layout` (optional;
   * `revealRegion('inspector')` before Show), `announce` (the editor's polite live region; default `host.announce`),
   * and `options` (`sourceEditor`, `readOnly`, `reveal`, `checks.display`, `scaffolds`). Returns `{ element,
   * selectTab(name), revealSource(range) | null, onReveal(listener) → unsubscribe, destroy() }`.
   */
  function createPanels(region, deps) {
    const { state, dom, ids } = deps;
    const options = deps.options || {};
    const view = region.ownerDocument.defaultView;
    const announce = deps.announce || (deps.host && deps.host.announce ? (message) => deps.host.announce(message) : () => {});
    const display = (options.checks && options.checks.display) || 'live';
    const hasSource = options.sourceEditor !== false;
    // The mount's stacked layout collapses regions; revealing one expands it and scrolls it into view (Ruling 17).
    const revealRegion = deps.layout && typeof deps.layout.revealRegion === 'function' ? deps.layout.revealRegion : () => {};
    // The state emits `diagnostics` only once Check now or Submit for review has released them (spec §9.3), whoever
    // called it; this listener runs before the panels' own, so they render with the release already known.
    let released = display === 'live';
    const unsubscribeRelease = state.on('diagnostics', () => { released = true; });
    const context = {
      state, dom, ids, options, view, announce, display,
      host: deps.host || {},
      actions: deps.actions || null,
      isReleased: () => released,
    };
    const element = dom.el('div', { class: 'c4-editor__panels' });

    const panels = {
      problems: createProblemsPanel(context, { show: showProblem, canRevealSource: hasSource }),
      review: createReviewPanel(context),
      explain: createExplainPanel(context),
    };
    if (hasSource) panels.yaml = createYamlPanel(context);
    const tabs = createTabs(dom, ids, TABS.filter((entry) => panels[entry.name]), panels);
    element.append(tabs.element, ...tabs.panelElements);
    region.appendChild(element);
    if (panels.yaml) panels.yaml.attach();

    const stopMarkingCardView = markCardView(region.closest('.c4-editor'), state);
    const banner = createErrorBanner(context, { goToError: panels.yaml ? revealSource : null });
    const bannerRegion = deps.bannerRegion || region;
    bannerRegion.insertBefore(banner.element, bannerRegion.firstChild);

    function revealSource(range) {
      revealRegion('panels');
      tabs.select('yaml');
      panels.yaml.reveal(range);
    }

    /**
     * Show (spec §9.2): a problem in the YAML itself moves the caret there; any other is a focus request through the
     * state, a selection carrying `focus: { path, request }` that the inspector answers by focusing the field at
     * `path` (`request` grows with every Show, so showing the same field again is a new selection). In the stacked
     * layout the inspector region is expanded first.
     */
    function showProblem(located, diagnostic) {
      if (located.selection === null) {
        if (panels.yaml && diagnostic.range) revealSource(diagnostic.range);
        return;
      }
      revealRegion('inspector');
      state.select(Object.assign({}, located.selection, { focus: { path: located.fieldPath, request: nextFocusRequest() } }));
    }

    let focusRequests = 0;
    function nextFocusRequest() {
      focusRequests += 1;
      return focusRequests;
    }

    return {
      element,
      selectTab: tabs.select,
      revealSource: panels.yaml ? revealSource : null,
      onReveal: panels.explain.onReveal,
      destroy() {
        unsubscribeRelease();
        stopMarkingCardView();
        Object.values(panels).forEach((panel) => panel.destroy());
        tabs.destroy();
        banner.destroy();
        element.remove();
      },
    };
  }

  // ---- Tabs (WAI-ARIA tabs: automatic activation; Left, Right, Home, End) ---------------------------------------------

  function createTabs(dom, ids, entries, panels) {
    const list = dom.el('div', { role: 'tablist', 'aria-label': TEXT.tablist, class: 'c4-editor__tabs' });
    const tabs = entries.map((entry) => dom.el('button', {
      type: 'button',
      role: 'tab',
      id: ids(`tab-${entry.name}`),
      class: 'c4-editor__tab',
      'aria-controls': ids(`panel-${entry.name}`),
      'data-c4-tab': entry.name,
    }, [entry.label, panels[entry.name].tabBadge || null]));
    const panelElements = entries.map((entry) => {
      const panel = panels[entry.name].element;
      panel.id = ids(`panel-${entry.name}`);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', ids(`tab-${entry.name}`));
      panel.setAttribute('tabindex', '0');
      panel.classList.add('c4-editor__panel', `c4-editor__panel--${entry.name}`);
      return panel;
    });
    list.append(...tabs);

    function select(name, { focus = false } = {}) {
      tabs.forEach((tab, index) => {
        const selected = entries[index].name === name;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        panelElements[index].hidden = !selected;
        if (selected && focus) tab.focus();
      });
    }

    function onKeydown(event) {
      const index = tabs.indexOf(event.target);
      if (index < 0) return;
      const last = tabs.length - 1;
      const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(entries[next].name, { focus: true });
    }

    function onClick(event) {
      const tab = event.target.closest('[role="tab"]');
      if (tab && tabs.includes(tab)) select(tab.dataset.c4Tab);
    }

    list.addEventListener('keydown', onKeydown);
    list.addEventListener('click', onClick);
    select(entries[0].name);
    return {
      element: list,
      panelElements,
      select: (name) => select(name),
      destroy() {
        list.removeEventListener('keydown', onKeydown);
        list.removeEventListener('click', onClick);
      },
    };
  }

  // ---- Problems ------------------------------------------------------------------------------------------------------

  function createProblemsPanel(context, { show, canRevealSource }) {
    const { state, dom, ids, view, announce, actions, display, isReleased, host } = context;
    const element = dom.el('div');
    const tabBadge = dom.el('span', { class: 'c4-editor__tab-count' });
    // Check now (on-request) or Submit for review (after-submit); the state's diagnostics event then re-renders. The
    // host hears of the learner's command with the diagnostics it released (spec §3.4: onCheckNow, onSubmitForReview);
    // the handle's own submitForReview() is the host's call, so it has no notice.
    const releaseCommand = {
      'on-request': { label: TEXT.checkNow, release: state.checkNow, notice: 'onCheckNow' },
      'after-submit': { label: TEXT.submitForReview, release: state.submitForReview, notice: 'onSubmitForReview' },
    }[display];
    const releaseButton = releaseCommand ? dom.el('button', {
      type: 'button', class: 'c4-editor__button', 'data-c4-focus-key': 'release', text: releaseCommand.label,
      on: {
        click: () => {
          const released = releaseCommand.release();
          if (typeof host[releaseCommand.notice] === 'function') host[releaseCommand.notice](released);
        },
      },
    }) : null;
    let announcedSummary = null;
    let announceTimer = null;

    function render() {
      const restore = focusKeyWithin(element);
      const diagnostics = state.getDiagnostics();
      const model = state.getDesign().model;
      const children = [];
      if (releaseButton) children.push(dom.el('div', { class: 'c4-editor__panel-actions' }, releaseButton));
      children.push(dom.el('p', { class: 'c4-editor__panel-status', text: statusText(diagnostics) }));
      SEVERITIES.forEach((entry) => {
        const rows = sortedByLine(diagnostics.filter((diagnostic) => diagnostic.severity === entry.severity));
        if (rows.length > 0) children.push(groupOf(entry, rows, model));
      });
      element.replaceChildren(...children);
      tabBadge.textContent = diagnostics.length > 0 ? ` ${diagnostics.length}` : '';
      restoreFocus(element, restore);
      if (isReleased()) scheduleCountAnnouncement(diagnostics);
    }

    function statusText(diagnostics) {
      if (!isReleased()) return display === 'after-submit' ? TEXT.hiddenUntilSubmit : TEXT.hiddenUntilCheck;
      return diagnostics.length === 0 ? TEXT.problemsEmpty : `${capitalized(countSummary(diagnostics))}.`;
    }

    function groupOf(entry, rows, model) {
      const labelId = ids(`problems-${entry.severity}`);
      return dom.el('div', { class: `c4-editor__problem-group c4-editor__problem-group--${entry.severity}` }, [
        dom.el('p', { id: labelId, class: 'c4-editor__group-label', text: entry.group }),
        dom.el('ul', { class: 'c4-editor__problem-list', 'aria-labelledby': labelId }, rows.map((diagnostic) => rowOf(diagnostic, model))),
      ]);
    }

    function rowOf(diagnostic, model) {
      const located = locateDiagnostic(model, diagnostic);
      const key = problemKey(diagnostic);
      const buttons = [];
      if (located.showName !== null && (located.selection !== null || canRevealSource)) {
        buttons.push(dom.el('button', {
          type: 'button', class: 'c4-editor__button', 'data-c4-focus-key': `${key}|show`,
          on: { click: () => show(located, diagnostic) },
        }, ['Show', dom.el('span', { class: 'c4-editor__sr-only', text: located.showName.slice('Show'.length) })]));
      }
      const fix = quickFixFor(diagnostic);
      if (fix) {
        const fixButton = dom.el('button', {
          type: 'button', class: 'c4-editor__button', 'data-c4-focus-key': `${key}|fix`,
          on: { click: () => fix.apply({ anchor: fixButton, returnFocus: fixButton }) },
        }, [fix.label, dom.el('span', { class: 'c4-editor__sr-only', text: ` (${located.place})` })]);
        buttons.push(fixButton);
      }
      return dom.el('li', { class: `c4-editor__problem c4-editor__problem--${diagnostic.severity}` }, [
        dom.el('p', { class: 'c4-editor__problem-message', text: diagnosticText(diagnostic) }),
        diagnostic.hint ? dom.el('p', { class: 'c4-editor__problem-hint', text: diagnostic.hint }) : null,
        dom.el('p', { class: 'c4-editor__problem-place', text: located.place }),
        buttons.length > 0 ? dom.el('div', { class: 'c4-editor__problem-actions' }, buttons) : null,
      ]);
    }

    /** The actions registry's quick fix (Ruling 20): `{ label, apply({ anchor, returnFocus }) }`, or null. */
    function quickFixFor(diagnostic) {
      return actions && typeof actions.quickFixFor === 'function' ? actions.quickFixFor(diagnostic) : null;
    }

    /** Announces the problem counts once they settle (spec §9.2); live counts at mount are the baseline, not news. */
    function scheduleCountAnnouncement(diagnostics) {
      const summary = diagnostics.length === 0 ? 'The checks found no problems.' : `Problems: ${countSummary(diagnostics)}.`;
      if (announcedSummary === null && display === 'live') announcedSummary = summary;
      view.clearTimeout(announceTimer);
      if (summary === announcedSummary) return;
      announceTimer = view.setTimeout(() => {
        announcedSummary = summary;
        announce(summary);
      }, COUNT_ANNOUNCE_DELAY_MS);
    }

    // Released diagnostics follow every text change with a `diagnostics` event; before release nothing changes here.
    const unsubscribes = [state.on('diagnostics', render)];
    render();
    return {
      element,
      tabBadge,
      destroy() {
        unsubscribes.forEach((unsubscribe) => unsubscribe());
        view.clearTimeout(announceTimer);
      },
    };
  }

  function problemKey(diagnostic) {
    const line = diagnostic.range ? diagnostic.range.start.line : '';
    return `${diagnostic.rule}|${(diagnostic.path || []).join('.')}|${line}`;
  }

  function sortedByLine(diagnostics) {
    const lineOf = (diagnostic) => (diagnostic.range ? diagnostic.range.start.line : Infinity);
    return diagnostics.slice().sort((a, b) => lineOf(a) - lineOf(b));
  }

  // ---- Review ----------------------------------------------------------------------------------------------------------

  function createReviewPanel(context) {
    const { state, dom, ids, display, isReleased, options } = context;
    const element = dom.el('div');
    let checked = { text: null, diagnostics: [] };

    function render() {
      const design = state.getDesign();
      const children = [
        dom.el('p', { class: 'c4-editor__group-label', text: TEXT.automated }),
        dom.el('p', { class: 'c4-editor__panel-status', text: automatedSummary(design) }),
      ];
      if (design.model !== null) {
        const viewModel = C4.project(design, state.getView());
        const reviewed = interfacesUnderReview(design.model, viewModel, state.getSelection());
        if (isReleased()) {
          interfaceGaps(reviewed, state.getDiagnostics()).forEach((gap, index) => children.push(...labelledList(`review-gap-${index}`, gap)));
        }
        if (options.profile === 'novice') children.push(...meaningChecklist(design, reviewed));
        const prompts = reviewPrompts(design.model, viewModel, state.getSelection());
        if (prompts.length > 0) {
          const labelId = ids('review-prompts');
          children.push(
            dom.el('p', { id: labelId, class: 'c4-editor__group-label', text: TEXT.prompts }),
            dom.el('ul', { class: 'c4-editor__prompt-list', 'aria-labelledby': labelId }, prompts.map((prompt) => dom.el('li', { text: prompt }))));
        }
      }
      element.replaceChildren(...children);
    }

    function labelledList(key, { label, items }) {
      const labelId = ids(key);
      return [
        dom.el('p', { id: labelId, class: 'c4-editor__group-label', text: label }),
        dom.el('ul', { class: 'c4-editor__prompt-list', 'aria-labelledby': labelId }, items.map((item) => dom.el('li', { text: item }))),
      ];
    }

    /**
     * The novice checklist (spec §7.2, §9.5): every field of the interfaces under review without a meaning. The
     * novice profile hides `interface/no-meaning` as a suggestion, so the list comes from the core's own check, in
     * every display mode; it lists what is left to write, not a verdict.
     */
    function meaningChecklist(design, reviewed) {
      if (reviewed.length === 0) return [];
      const text = state.getText();
      if (checked.text !== text) checked = { text, diagnostics: C4.check(design) };
      const [gap] = interfaceGaps(reviewed, checked.diagnostics.filter((diagnostic) => diagnostic.rule === 'interface/no-meaning'));
      return gap ? labelledList('review-meaning-checklist', { label: MEANING_CHECKLIST, items: gap.items }) : [];
    }

    /** The checks' findings for this view and the whole model, in the display mode's terms. */
    function automatedSummary(design) {
      if (!isReleased()) {
        return display === 'after-submit' ? 'The checks run when you submit for review.' : 'The checks run when you choose Check now.';
      }
      const diagnostics = state.getDiagnostics();
      if (diagnostics.length === 0) return 'The checks found no problems.';
      const inView = design.model === null ? [] : diagnosticsInView(design, diagnostics);
      const viewPart = inView.length === 0 ? 'None in this view' : `In this view: ${countSummary(inView)}`;
      return `${viewPart}. In the whole model: ${countSummary(diagnostics)}. Problems lists each one.`;
    }

    function diagnosticsInView(design, diagnostics) {
      const shown = new Set(C4.project(design, state.getView()).nodes.map((node) => node.id));
      return diagnostics.filter((diagnostic) => shown.has(diagnostic.element));
    }

    const unsubscribes = ['text', 'view', 'selection', 'diagnostics'].map((event) => state.on(event, render));
    render();
    return { element, destroy: () => unsubscribes.forEach((unsubscribe) => unsubscribe()) };
  }

  // ---- Explain (the verbose description; printed whatever the active tab) -------------------------------------------

  /**
   * Print shows Explain whatever the active tab, except when the canvas shows an interface card: the card is its own
   * text, so it prints once and Explain does not (spec §9.4). The editor root carries `c4-editor--card-view` while
   * the open view is a card (Ruling 27; c4-editor.css hides Explain in print under it). Returns the function that
   * stops marking and removes the class.
   */
  function markCardView(editorRoot, state) {
    if (!editorRoot) return () => {};
    function mark() {
      const design = state.getDesign();
      const isCard = design.model !== null && state.getView() !== null
        && C4.project(design, state.getView()).notation === 'interface-card';
      editorRoot.classList.toggle('c4-editor--card-view', isCard);
    }
    const unsubscribes = [state.on('view', mark), state.on('text', mark)];
    mark();
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      editorRoot.classList.remove('c4-editor--card-view');
    };
  }

  function createExplainPanel(context) {
    const { state, dom, ids, options } = context;
    const element = dom.el('div');
    const revealListeners = new Set();
    let revealed = options.reveal !== 'on-request';

    function render() {
      if (!revealed) {
        element.replaceChildren(
          dom.el('p', { text: TEXT.explainHidden }),
          dom.el('button', { type: 'button', class: 'c4-editor__button', text: TEXT.showInside, on: { click: reveal } }));
        return;
      }
      const design = state.getDesign();
      if (design.model === null) {
        element.replaceChildren(dom.el('p', { text: TEXT.explainUnreadable }));
        return;
      }
      const description = C4.describe(C4.project(design, state.getView()));
      element.replaceChildren(
        dom.el('p', { class: 'c4-editor__explain-brief', text: description.brief }),
        ...description.sections.map((section, index) => {
          const labelId = ids(`explain-section-${index}`);
          return [
            dom.el('p', { id: labelId, class: 'c4-editor__group-label', text: section.heading }),
            dom.el('ul', { class: 'c4-editor__explain-list', 'aria-labelledby': labelId }, section.items.map((item) => dom.el('li', { text: item }))),
          ];
        }).flat());
    }

    /** "Show inside" (spec §9.3, `reveal: 'on-request'`): shows the description and tells the mount. */
    function reveal() {
      revealed = true;
      render();
      element.focus();
      revealListeners.forEach((listener) => listener());
    }

    const unsubscribes = [state.on('text', render), state.on('view', render)];
    render();
    return {
      element,
      onReveal(listener) {
        revealListeners.add(listener);
        return () => revealListeners.delete(listener);
      },
      destroy: () => unsubscribes.forEach((unsubscribe) => unsubscribe()),
    };
  }

  // ---- YAML (two-way sync with the state, diagnostics as markers) ------------------------------------------------------

  function createYamlPanel(context) {
    const { state, dom, ids, options, view, host } = context;
    const element = dom.el('div');
    const container = dom.el('div', { class: 'c4-editor__source' });
    element.appendChild(container);
    let handle = null;
    let subscription = null;
    let pending = null;
    let writing = false;
    const unsubscribes = [];

    /** Creates the source editor once the panel is in the document (a host editor measures its container). */
    function attach() {
      // One undo history (spec §3.4): a host source editor routes its undo keys here, after any typing still waiting.
      const sourceOptions = {
        value: state.getText(), language: 'yaml', label: TEXT.source, readOnly: Boolean(options.readOnly),
        undo: () => { syncNow(); state.undo(); },
        redo: () => { syncNow(); state.redo(); },
      };
      handle = typeof host.createSourceEditor === 'function'
        ? host.createSourceEditor(container, sourceOptions)
        : createTextareaSourceEditor(container, sourceOptions, { dom, ids });
      subscription = handle.onDidChange(onTyped);
      unsubscribes.push(state.on('text', onStateText), state.on('diagnostics', refreshMarkers), state.on('mode', refreshMarkers));
      refreshMarkers();
    }

    /** Applies typing still waiting for its debounce, so an undo or redo after it steps from the typed text. */
    function syncNow() {
      if (pending === null) return;
      view.clearTimeout(pending);
      pending = null;
      state.applySourceText(handle.getValue());
    }

    function onTyped() {
      if (writing) return;
      view.clearTimeout(pending);
      pending = view.setTimeout(() => {
        pending = null;
        state.applySourceText(handle.getValue());
      }, SOURCE_DEBOUNCE_MS);
    }

    /**
     * Every change of the state's text that this panel does not show yet replaces what it shows: host text, undo, a
     * visual edit, and an inspector form's change, which reaches the state as 'source' text like this panel's own
     * typing. Typing that had not reached the state is replaced too; a sync still pending then reads the replaced text,
     * so it changes nothing. The panel's own typing, once applied, is what it shows already, so nothing is written.
     */
    function onStateText(text, info) {
      writeQuietly(text, info.edits);
      refreshMarkers();
    }

    function writeQuietly(text, edits) {
      const current = handle.getValue();
      if (current === text) return;
      writing = true;
      try {
        if (edits && edits.length > 0 && applySplices(current, edits) === text) handle.applyEdits(edits);
        else handle.setValue(text);
      } finally {
        writing = false;
      }
    }

    /** Syntax errors always (the banner names them too); other diagnostics once the display mode releases them. */
    function refreshMarkers() {
      const byKey = new Map();
      state.getMode().errors.concat(state.getDiagnostics())
        .filter((diagnostic) => diagnostic.range)
        .forEach((diagnostic) => byKey.set(problemKey(diagnostic), diagnostic));
      const markers = [...byKey.values()]
        .map((diagnostic) => ({ severity: diagnostic.severity, rule: diagnostic.rule, message: diagnosticText(diagnostic), range: diagnostic.range }));
      handle.setMarkers(sortedByLine(markers));
    }

    return {
      element,
      attach,
      /** Moves the caret to `range` and focuses the source editor ("Go to error", Show). */
      reveal(range) {
        handle.revealRange(range);
        handle.focus();
      },
      destroy() {
        view.clearTimeout(pending);
        unsubscribes.forEach((unsubscribe) => unsubscribe());
        if (subscription) subscription.dispose();
        if (handle) handle.dispose();
      },
    };
  }

  /** `text` with `{ offset, length, text }` splices applied, the last first so that earlier offsets stay valid. */
  function applySplices(text, edits) {
    return edits.slice().sort((a, b) => b.offset - a.offset)
      .reduce((result, edit) => result.slice(0, edit.offset) + edit.text + result.slice(edit.offset + edit.length), text);
  }

  // ---- The textarea source editor (fallback for hosts without createSourceEditor) -----------------------------------

  /**
   * A SourceEditor handle (spec §3.4) over a labelled `<textarea>`: `{ getValue, setValue, applyEdits, revealRange,
   * setMarkers, focus, onDidChange(listener) → { dispose }, dispose }`. Markers (`{ severity, message, range }`) are
   * listed under the field and describe it; the field is `aria-invalid` while one of them is an error. Writing text
   * keeps the caret where it was relative to the text around it and never moves focus.
   */
  function createTextareaSourceEditor(container, sourceOptions, { dom, ids }) {
    const fieldId = ids('yaml-source');
    const markersLabelId = ids('yaml-markers-label');
    const markersId = ids('yaml-markers');
    const field = dom.el('textarea', {
      id: fieldId, class: 'c4-editor__source-text', rows: 20, wrap: 'off',
      spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', readonly: Boolean(sourceOptions.readOnly),
    });
    field.value = sourceOptions.value;
    const markersLabel = dom.el('p', { id: markersLabelId, class: 'c4-editor__group-label', text: TEXT.markers, hidden: true });
    const markerList = dom.el('ul', { id: markersId, class: 'c4-editor__marker-list', 'aria-labelledby': markersLabelId, hidden: true });
    const parts = [dom.el('label', { for: fieldId, class: 'c4-editor__source-label', text: sourceOptions.label }), field, markersLabel, markerList];
    container.append(...parts);

    function write(text, mapOffset) {
      const start = mapOffset(field.selectionStart);
      const end = mapOffset(field.selectionEnd);
      field.value = text;
      field.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
    }

    return {
      getValue: () => field.value,
      setValue: (text) => write(text, (offset) => offset),
      applyEdits(edits) {
        const mapOffset = (offset) => edits.reduce((mapped, edit) => {
          if (mapped <= edit.offset) return mapped;
          if (mapped >= edit.offset + edit.length) return mapped + edit.text.length - edit.length;
          return edit.offset + edit.text.length;
        }, offset);
        write(applySplices(field.value, edits), mapOffset);
      },
      revealRange(range) {
        const offset = offsetOf(field.value, range.start.line, range.start.col);
        field.setSelectionRange(offset, offset);
        const lineHeight = parseFloat(field.ownerDocument.defaultView.getComputedStyle(field).lineHeight) || 0;
        field.scrollTop = Math.max(0, (range.start.line - 3) * lineHeight);
      },
      setMarkers(markers) {
        const items = markers.map((marker, index) => dom.el('li', {
          id: ids(`yaml-marker-${index}`), text: `Line ${marker.range.start.line}: ${marker.message}`,
        }));
        markerList.replaceChildren(...items);
        markersLabel.hidden = markers.length === 0;
        markerList.hidden = markers.length === 0;
        // The items, not the labelled list: a list would describe the field by its label alone.
        setDescribedBy(field, items.map((item) => item.id));
        if (markers.some((marker) => marker.severity === 'error')) field.setAttribute('aria-invalid', 'true');
        else field.removeAttribute('aria-invalid');
      },
      focus: () => field.focus(),
      onDidChange(listener) {
        field.addEventListener('input', listener);
        return { dispose: () => field.removeEventListener('input', listener) };
      },
      dispose: () => parts.forEach((part) => part.remove()),
    };
  }

  /** The offset of 1-based `line` and `column` in `text`. */
  function offsetOf(text, line, column) {
    const lines = text.split('\n');
    const before = lines.slice(0, line - 1).reduce((total, current) => total + current.length + 1, 0);
    return Math.min(text.length, before + Math.max(0, column - 1));
  }

  // ---- The YAML-error banner (spec §7.3) -------------------------------------------------------------------------------

  /**
   * A polite status region that, while the YAML cannot be read, names the first error's line and says that the
   * diagram is the last valid model and visual editing is off; "Go to error" moves the caret there.
   */
  function createErrorBanner(context, { goToError }) {
    const { state, dom } = context;
    const element = dom.el('div', { role: 'status', class: 'c4-editor__banner-region' });
    let shown = null;

    function render() {
      const mode = state.getMode();
      const first = mode.reason === 'yaml-errors' ? mode.errors.find((error) => error.range) || mode.errors[0] : null;
      const key = first ? problemKey(first) : null;
      if (key === shown) return;
      shown = key;
      if (first === null) {
        element.replaceChildren();
        return;
      }
      element.replaceChildren(dom.el('div', { class: 'c4-editor__banner' }, [
        dom.el('p', { class: 'c4-editor__banner-text', text: bannerText(first, state.getDesign().model !== null) }),
        goToError && first.range ? dom.el('button', {
          type: 'button', class: 'c4-editor__button', text: TEXT.goToError, on: { click: () => goToError(first.range) },
        }) : null,
      ]));
    }

    const unsubscribes = [state.on('mode', render), state.on('text', render)];
    render();
    return {
      element,
      destroy() {
        unsubscribes.forEach((unsubscribe) => unsubscribe());
        element.remove();
      },
    };
  }

  function bannerText(error, hasValidModel) {
    const where = error.range ? `Line ${error.range.start.line} of the YAML` : 'The YAML';
    const shown = hasValidModel
      ? 'The diagram shows the last valid model, and visual editing is off until the YAML is fixed.'
      : 'Nothing can be drawn until the YAML is fixed.';
    return `Error: ${where} cannot be read (${error.message}). ${shown}`;
  }

  // ---- Helpers -----------------------------------------------------------------------------------------------------------

  function startsWith(path, prefix) {
    return Array.isArray(path) && prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
  }

  function nameOf(model, id) {
    const element = model.elements.get(id);
    return element ? element.name : id;
  }

  function capitalized(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function describedBy(node) {
    return (node.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  }

  function setDescribedBy(node, tokens) {
    if (tokens.length > 0) node.setAttribute('aria-describedby', tokens.join(' '));
    else node.removeAttribute('aria-describedby');
  }

  /** The focus key of the focused control inside `container`, kept across a re-render, or null. */
  function focusKeyWithin(container) {
    const active = container.ownerDocument.activeElement;
    if (!active || !container.contains(active)) return null;
    return active.getAttribute('data-c4-focus-key') || '';
  }

  /** Puts focus back on the control with `key` after a re-render, or on the panel when that control is gone. */
  function restoreFocus(container, key) {
    if (key === null) return;
    const target = key ? container.querySelector(`[data-c4-focus-key="${cssString(key)}"]`) : null;
    (target || container).focus();
  }

  function cssString(text) {
    return String(text).replace(/["\\]/g, '\\$&');
  }

  return {
    createPanels: createPanels,
    createCommandGate: createCommandGate,
    createTextareaSourceEditor: createTextareaSourceEditor,
    disabledReason: disabledReason,
    diagnosticText: diagnosticText,
    locateDiagnostic: locateDiagnostic,
    fieldDiagnostics: fieldDiagnostics,
    reviewPrompts: reviewPrompts,
    interfaceGaps: interfaceGaps,
  };
});
