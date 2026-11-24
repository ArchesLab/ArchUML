(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { inspectorShared: require('./c4-editor-inspector-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorScenarios = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
    // The dynamic canvas's step and fragment forms (UML-view editing plan Task 45): each editor makes its own from its kit.
    parts.umlFormFactories = parts.umlFormFactories || {};
    parts.umlFormFactories.step = parts.inspectorScenarios.createStepForm;
    parts.umlFormFactories.fragment = parts.inspectorScenarios.createFragmentForm;
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // The scenario form (spec §9.1, §9.2), one of the inspector's supplementary forms (c4-editor-inspector-records.js),
  // built from its kit: a scenario's title and description, and its steps: messages with a sender and receiver that
  // a relationship backs, and fragments (alt, opt, loop, par, break) whose branches hold step lists of their own. A
  // step selected on the canvas has its row revealed and marked here (UML-view editing spec §7.6; revealStep).
  //
  // The same step and fragment fields make the anchored forms of the dynamic canvas (UML-view editing spec §5.3;
  // createStepForm, createFragmentForm): Sender, Receiver, Position, Description, and the connector for a step;
  // Operator, Guard, and Position for a fragment. They share the scenario form's words (STEP_WORDS, FRAGMENT_LABELS),
  // write nothing, and resolve the learner's answer, so the dynamic view module plans the change and the C4 model
  // adapter makes it. Escape or Cancel adds nothing, and the form says so.

  const FRAGMENT_LABELS = {
    alt: 'alt: one of several branches, chosen by its guard',
    opt: 'opt: runs only when its guard holds',
    loop: 'loop: repeats while its guard holds',
    par: 'par: branches that run at the same time',
    break: 'break: ends the scenario when its guard holds',
  };
  const MULTI_BRANCH_FRAGMENTS = ['alt', 'par'];
  const CONNECTORS = ['call', 'message', 'event', 'stream', 'shared-data'];
  // The words of a step's and a fragment's fields, in the scenario form and in the canvas's anchored forms.
  const STEP_WORDS = Object.freeze({
    descriptionHint: 'Say what the sender asks the receiver for, starting with a verb.',
    guardHint: 'The condition under which the branch runs, such as "eligible".',
    noSender: 'Error: Choose who sends the step first.',
    noReceiver: 'Error: Choose who receives the step.',
    noDescription: 'Error: Describe the step first.',
    noGuard: 'Error: Write the condition under which the branch runs.',
  });
  // What the anchored forms say when Escape or Cancel closes them (spec §5.3).
  const NOT_ADDED = Object.freeze({ step: 'No step added.', fragment: 'No fragment added.' });

  /**
   * The scenario form. `kit` is the inspector's shared context: the form kit, `state`, `dom`, `announce`, and `splices`.
   * Returns `scenarioForm(model, scenarioId)`.
   */
  function createScenarioForms(kit) {
    const { state, dom, announce, field, formSection, button, listEditor, run, problem, lockReason, touchesLock, requestFocus,
      byKey, form, gone, group, splices } = kit;
    const { TEXT, setOrDelete, textValue, withCurrent, elementChoices, capitalize, onEnter } = editorParts().inspectorShared;
    // Valid step ends per list position, for the text they were computed on.
    let validEnds = { text: null, byPosition: new Map() };
    // A step selected on the canvas: its row is revealed and marked once the form showing it is on the page.
    if (typeof kit.registerRevealStep === 'function') kit.registerRevealStep((selection) => revealStep(kit, selection));

    function scenarioForm(model, scenarioId) {
      const scenario = model.scenarios.get(scenarioId);
      if (!scenario) return gone('This scenario is no longer in the model.');
      const title = scenario.title || scenario.id;
      const write = (key, label) => (value) => splices.write(label, [(parsed, yaml) => setOrDelete(yaml, parsed, scenario.path, key, value)]);
      return form(`Scenario: ${title}`, 'Scenario: the steps of one use of the system, drawn as a sequence diagram', [
        formSection('scenario-basics', 'Basics', dom.el('div', { class: 'c4-editor__fields' }, [
          field({ key: 'scenario-title', label: 'Title', value: scenario.title, path: scenario.path.concat('title'),
            onCommit: (value) => (value.trim() === '' ? problem('scenario-title', 'Error: A scenario needs a title.')
              : write('title', `Rename the scenario ${title}`)(value.trim())) }),
          field({ key: 'scenario-description', label: 'Description', control: 'textarea', value: scenario.description,
            path: scenario.path.concat('description'), onCommit: (value) => write('description', `Describe the scenario ${title}`)(textValue(value)) }),
          state.getView() === `dynamic ${scenario.id}` ? null
            : button('Show the sequence diagram', () => state.openView(`dynamic ${scenario.id}`), { 'data-c4-focus-key': 'scenario-show' }),
        ])),
        formSection('steps', 'Steps', stepListEditor(model, scenario, [], scenario.steps, scenario.path.concat('steps'), null)),
      ]);
    }

    /**
     * The editor of one step list: the scenario's own (`containerPath` []) or a fragment branch's (spec §4.8's container
     * path, such as [2, 'alt', 0]). `owner` names the branch for labels ("branch 1 of step 3"), or null at the top.
     */
    function stepListEditor(model, scenario, containerPath, steps, yamlPath, owner) {
      const listKey = `steps${containerPath.length > 0 ? `-${containerPath.join('-')}` : ''}`;
      const reason = lockReason(yamlPath);
      const stepLabel = (index) => (owner ? `step ${index + 1} of ${owner}` : `step ${index + 1}`);
      const rows = listEditor({
        name: listKey,
        label: owner ? `Steps of ${owner}` : 'Steps',
        itemName: 'step',
        itemLabel: stepLabel,
        items: steps,
        locked: touchesLock(yamlPath) ? (reason || TEXT.locked) : null,
        rowLocked: (index) => lockReason(steps[index].path),
        renderRow: (step, index) => (step.kind === 'fragment'
          ? fragmentRow(model, scenario, containerPath, step, index, stepLabel(index))
          : messageRow(model, scenario, containerPath, step, index, stepLabel(index))),
        onMove: (from, to) => run({ op: 'moveStep', scenarioId: scenario.id, containerPath, from, to }, `Move ${stepLabel(from)}`),
        onRemove: (index) => run({ op: 'removeStep', scenarioId: scenario.id, containerPath, index }, `Remove ${stepLabel(index)}`),
        emptyFocusKey: `${listKey}-new-from`,
      });
      return [
        reason ? dom.el('p', { class: 'c4-editor__lock-note', text: reason }) : null,
        steps.length > 0 ? rows : dom.el('p', { class: 'c4-editor__field-hint', text: owner ? `No steps in ${owner} yet.` : 'No steps yet.' }),
        reason ? null : newStep(model, scenario, containerPath, steps.length, listKey, owner),
        reason ? null : newFragment(model, scenario, containerPath, steps.length, listKey, yamlPath, owner),
      ];
    }

    /**
     * The core's `stepEnds` (`{ froms, tosOf(from), … }`) for a step at `index` of a step list, cached per text. With
     * `sender`, only that sender's ends are offered (an existing step's receiver picker).
     */
    function endsAt(scenario, containerPath, index, replace, sender = null) {
      if (validEnds.text !== state.getText()) validEnds = { text: state.getText(), byPosition: new Map() };
      const key = JSON.stringify([scenario.id, containerPath, index, replace, sender]);
      if (!validEnds.byPosition.has(key)) {
        validEnds.byPosition.set(key, C4.stepEnds(state.getDesign(), { scenarioId: scenario.id, containerPath, index, replace, sender }));
      }
      return validEnds.byPosition.get(key);
    }

    function messageRow(model, scenario, containerPath, step, index, label) {
      const key = `${containerPath.join('-')}-${index}`;
      const ends = endsAt(scenario, containerPath, index, true, step.from);
      const update = (changes, what) => run({ op: 'updateStep', scenarioId: scenario.id, containerPath, index, step: changes },
        `Edit the ${what} of ${label}`);
      const quiet = { quietLock: true, lintPath: null };
      return dom.el('div', { class: 'c4-editor__step', 'data-c4-step': stepKey(containerPath, index) }, [
        dom.el('div', { class: 'c4-editor__step-ends' }, [
          field(Object.assign({ key: `step-${key}-from`, label: `Sender of ${label}`, control: 'select', value: step.from,
            choices: elementChoices(model, withCurrent(C4.structuralSenders(state.getDesign()), step.from)), path: step.path,
            onCommit: (value) => update({ from: value }, 'sender') }, quiet)),
          field({ key: `step-${key}-to`, label: `Receiver of ${label}`, control: 'select', value: step.to, quietLock: true,
            choices: receiverChoices(model, ends, step.from, step.to), path: step.path, lintPath: step.path, exactLint: true,
            onCommit: (value) => update({ to: value }, 'receiver') }),
        ]),
        field(Object.assign({ key: `step-${key}-description`, label: `Description of ${label}`, value: step.description,
          path: step.path, onCommit: (value) => update({ description: textValue(value) }, 'description') }, quiet)),
        dom.el('div', { class: 'c4-editor__step-details' }, [
          field(Object.assign({ key: `step-${key}-technology`, label: `Technology of ${label}`, value: step.technology,
            path: step.path, onCommit: (value) => update({ technology: textValue(value) }, 'technology') }, quiet)),
          field(Object.assign({ key: `step-${key}-connector`, label: `Connector of ${label}`, control: 'select', value: step.connector || '',
            choices: connectorChoices(), path: step.path,
            onCommit: (value) => update({ connector: value === '' ? null : value }, 'connector') }, quiet)),
        ]),
      ]);
    }

    function receiverChoices(model, ends, from, current) {
      const valid = ends.tosOf(from);
      const choices = elementChoices(model, withCurrent(valid, current));
      // The current receiver stays listed so the form tells the truth; its problem is shown under the field.
      return choices.map((choice) => (valid.includes(choice.value) ? choice
        : Object.assign({}, choice, { label: `${choice.label} (no relationship backs this step)` })));
    }

    function connectorChoices() {
      return [{ value: '', label: 'As its relationship' }].concat(CONNECTORS.map((connector) => ({ value: connector, label: connector })));
    }

    /** "New step": From offers the senders of a valid step at the end of the list; To the receivers for the chosen sender. */
    function newStep(model, scenario, containerPath, index, listKey, owner) {
      const key = `${listKey}-new`;
      const ends = endsAt(scenario, containerPath, index, false);
      const toChoices = (from) => [{ value: '', label: from ? 'Choose the receiver…' : 'Choose the sender first' }]
        .concat(from ? elementChoices(model, ends.tosOf(from)) : []);
      const fromField = field({ key: `${key}-from`, label: 'From', control: 'select', value: '', path: scenario.path, lintPath: null,
        choices: [{ value: '', label: 'Choose the sender…' }].concat(elementChoices(model, ends.froms)),
        onCommit: (from) => replaceOptions(byKey(`${key}-to`), toChoices(from)) });
      const toField = field({ key: `${key}-to`, label: 'To', control: 'select', value: '', path: scenario.path, lintPath: null,
        choices: toChoices(''), hint: ends.froms.length === 0 ? 'No relationship lets any element send a step here yet; declare one first.' : null,
        onCommit: () => {} });
      const descriptionField = field({ key: `${key}-description`, label: 'Description', value: '', path: scenario.path, lintPath: null,
        hint: STEP_WORDS.descriptionHint, onCommit: () => {} });
      const technologyField = field({ key: `${key}-technology`, label: 'Technology', value: '', path: scenario.path, lintPath: null, onCommit: () => {} });
      const add = () => {
        const [from, to, description, technology] = ['from', 'to', 'description', 'technology'].map((part) => byKey(`${key}-${part}`).value.trim());
        if (from === '') return problem(`${key}-from`, STEP_WORDS.noSender);
        if (to === '') return problem(`${key}-to`, STEP_WORDS.noReceiver);
        if (description === '') return problem(`${key}-description`, STEP_WORDS.noDescription);
        const step = Object.assign({ from, to, description }, technology === '' ? {} : { technology });
        if (run({ op: 'addStep', scenarioId: scenario.id, containerPath, index, step }, `Add a step to ${owner || scenario.title || scenario.id}`)) {
          announce(`Added ${owner ? `step ${index + 1} of ${owner}` : `step ${index + 1}`}.`);
          requestFocus(`${key}-from`);
        }
        return true;
      };
      descriptionField.querySelector('input').addEventListener('keydown', onEnter(add));
      return group(key, owner ? `New step in ${owner}` : 'New step', [
        dom.el('div', { class: 'c4-editor__step-ends' }, [fromField, toField]),
        descriptionField, technologyField,
        button('Add step', add, { 'data-c4-focus-key': `${key}-add` }),
      ], 'c4-editor__list-add');
    }

    /**
     * Dispatches `command` as one change and one undo step labelled `label`. A refusal is shown under the field `key`
     * in the state's words for it.
     */
    function commitAt(key, command, label) {
      const result = state.dispatch(command, { label });
      if (!result.ok) problem(key, state.refusalText(result));
      return result.ok;
    }

    /** "New fragment": the operator, its guard, and for alt and par the second branch's guard, written as one change. */
    function newFragment(model, scenario, containerPath, index, listKey, yamlPath, owner) {
      const key = `${listKey}-fragment`;
      const secondGuard = field({ key: `${key}-guard-2`, label: 'Guard of the second branch', value: '', path: yamlPath, lintPath: null,
        hint: 'Optional; an alt usually has a branch for the other case, such as "not eligible".', onCommit: () => {} });
      const operatorField = field({ key: `${key}-operator`, label: 'Fragment', control: 'select', value: 'alt', path: yamlPath, lintPath: null,
        choices: Object.keys(FRAGMENT_LABELS).map((operator) => ({ value: operator, label: FRAGMENT_LABELS[operator] })),
        onCommit: (operator) => { secondGuard.hidden = !MULTI_BRANCH_FRAGMENTS.includes(operator); } });
      const guardField = field({ key: `${key}-guard`, label: 'Guard', value: '', path: yamlPath, lintPath: null,
        hint: STEP_WORDS.guardHint, onCommit: () => {} });
      const insert = () => {
        const operator = byKey(`${key}-operator`).value;
        const guard = byKey(`${key}-guard`).value.trim();
        const second = MULTI_BRANCH_FRAGMENTS.includes(operator) ? byKey(`${key}-guard-2`).value.trim() : '';
        const at = { scenarioId: scenario.id, containerPath, index };
        // The core refuses a branch without a guard (empty-guard) with this form's sentence, shown under Guard.
        const commands = [Object.assign({ op: 'addFragment', operator }, at), Object.assign({ op: 'setBranchGuard', branch: 0, when: guard }, at)]
          .concat(second === '' ? [] : [Object.assign({ op: 'addBranch', when: second }, at)]);
        const label = owner ? `step ${index + 1} of ${owner}` : `step ${index + 1}`;
        if (commitAt(`${key}-guard`, { op: 'batch', commands }, `Insert an ${operator} fragment`)) {
          announce(`Inserted an ${operator} fragment as ${label}.`);
          requestFocus(`${key}-operator`);
        }
        return true;
      };
      guardField.querySelector('input').addEventListener('keydown', onEnter(insert));
      return group(key, owner ? `New fragment in ${owner}` : 'New fragment', [
        operatorField, guardField, secondGuard,
        button('Insert fragment', insert, { 'data-c4-focus-key': `${key}-insert` }),
      ], 'c4-editor__list-add');
    }

    /** A fragment step: its operator, then each branch with its guard and its own step list. */
    function fragmentRow(model, scenario, containerPath, fragment, index, label) {
      const operatorPath = fragment.path.concat(fragment.operator);
      const multi = MULTI_BRANCH_FRAGMENTS.includes(fragment.operator);
      const at = { scenarioId: scenario.id, containerPath, index };
      // Removing any branch renumbers the branches after it, so a lock anywhere in the operator's list forbids it.
      const canRemove = multi && fragment.branches.length > 1 && !touchesLock(operatorPath);
      const branches = fragment.branches.map((branch, branchIndex) => {
        const branchPath = multi ? operatorPath.concat(branchIndex) : operatorPath;
        const owner = `branch ${branchIndex + 1} of ${label}`;
        const branchContainer = containerPath.concat(containerPath.length > 0 ? ['steps'] : [], index, fragment.operator, multi ? [branchIndex] : []);
        const guardKey = `guard-${branchContainer.join('-')}`;
        return group(`branch-${branchContainer.join('-')}`, capitalize(owner), [
          field({ key: guardKey, label: `Guard of ${owner}`, value: branch.when, path: branchPath.concat('when'), quietLock: true,
            onCommit: (value) => commitAt(guardKey, Object.assign({ op: 'setBranchGuard', branch: branchIndex, when: value.trim() }, at),
              `Edit the guard of ${owner}`) }),
          stepListEditor(model, scenario, branchContainer, branch.steps, branchPath.concat('steps'), owner),
          canRemove ? button(`Remove ${owner}`, () => {
            if (run(Object.assign({ op: 'removeBranch', branch: branchIndex }, at), `Remove ${owner}`)) {
              announce(`Removed ${owner}.`);
              requestFocus(`guard-${branchContainer.slice(0, -1).concat(0).join('-')}`);
            }
          }, { 'data-c4-focus-key': `remove-${branchContainer.join('-')}` }) : null,
        ], 'c4-editor__branch');
      });
      return dom.el('div', { class: 'c4-editor__fragment', 'data-c4-step': stepKey(containerPath, index) }, [
        dom.el('p', { class: 'c4-editor__fragment-operator', text: `${capitalize(label)}: ${FRAGMENT_LABELS[fragment.operator]}` }),
        branches,
        // Adding a branch writes a new item at the end of the operator's list, so any lock that covers that item
        // (the list, an `alt.*` wildcard, or `alt.*.when`) forbids it; a lock on an existing branch does not.
        multi && !touchesLock(operatorPath.concat(fragment.branches.length)) ? newBranch(at, fragment, operatorPath, label) : null,
      ]);
    }

    function newBranch(at, fragment, operatorPath, label) {
      const key = `new-branch-${fragment.path.join('-')}`;
      const guardField = field({ key, label: `Guard of a new branch of ${label}`, value: '', path: operatorPath, lintPath: null, onCommit: () => {} });
      const add = () => {
        // The core refuses a branch without a guard (empty-guard) with the scenario form's sentence, shown here.
        if (commitAt(key, Object.assign({ op: 'addBranch', when: byKey(key).value.trim() }, at), `Add a branch to ${label}`)) {
          announce(`Added branch ${fragment.branches.length + 1} of ${label}.`);
          requestFocus(key);
        }
        return true;
      };
      guardField.querySelector('input').addEventListener('keydown', onEnter(add));
      return dom.el('div', { class: 'c4-editor__list-add' }, [guardField, button(`Add a branch to ${label}`, add)]);
    }

    return { scenarioForm };
  }

  // ---- The selected step's row (UML-view editing spec §7.6, §7.7) -------------------------------------------------

  /** The key a step row carries (`data-c4-step`): its list's container path and its index there. */
  function stepKey(containerPath, index) {
    return JSON.stringify([containerPath, index]);
  }

  const STEP_MARK = 'Selected on the canvas.';

  /**
   * Reveals and marks the row of the step `selection` names (`{ scenarioId, step: { containerPath, index } }`) in the
   * scenario form on the page: the row gets `aria-current` and the visible words "Selected on the canvas." (a cue
   * that is not colour), and only the inspector's own scroll box scrolls to it, never the page or the canvas, so the
   * focused option stays in view.
   */
  function revealStep(kit, selection) {
    const rows = [...kit.element.querySelectorAll('[data-c4-step]')];
    rows.forEach((row) => {
      row.removeAttribute('aria-current');
      row.querySelectorAll(':scope > [data-c4-step-mark]').forEach((mark) => mark.remove());
    });
    const wanted = stepKey(selection.step.containerPath, selection.step.index);
    const row = rows.find((candidate) => candidate.getAttribute('data-c4-step') === wanted);
    if (!row) return;
    row.setAttribute('aria-current', 'true');
    row.prepend(kit.dom.el('p', { class: 'c4-editor__field-hint', 'data-c4-step-mark': '', text: STEP_MARK }));
    const scroller = scrollBoxOf(row);
    if (scroller) kit.dom.revealInScrollRegion(row, scroller);
  }

  /** The nearest ancestor of `element` inside its editor that scrolls its content, or null. */
  function scrollBoxOf(element) {
    const view = element.ownerDocument.defaultView;
    for (let box = element.parentElement; box; box = box.parentElement) {
      const overflow = view.getComputedStyle(box).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && box.scrollHeight > box.clientHeight) return box;
      if (box.classList.contains('c4-editor')) return null;
    }
    return null;
  }

  // ---- The anchored step and fragment forms of the dynamic canvas (UML-view editing spec §5.3, §7.7) ----------------

  /**
   * One labelled control of an anchored form, with its hint and its problem line (both tied to it by
   * `aria-describedby`). `spec`: `id`, `label`, `control` ('select' or 'text'), `value`, `choices` ([{ value, label }]),
   * `hint`. Returns `{ element, control, showProblem(text), clearProblem() }`.
   */
  function formControl(dom, spec) {
    const control = spec.control === 'select'
      ? dom.el('select', { id: spec.id, class: 'c4-editor__select' },
        spec.choices.map((choice) => dom.el('option', { value: choice.value, text: choice.label })))
      : dom.el('input', { type: 'text', id: spec.id, class: 'c4-editor__input', autocomplete: 'off', value: spec.value || '' });
    if (spec.control === 'select') control.value = spec.value;
    const hint = spec.hint ? dom.el('p', { id: `${spec.id}-hint`, class: 'c4-editor__field-hint', text: spec.hint }) : null;
    const problemLine = dom.el('p', { id: `${spec.id}-problem`, class: 'c4-editor__field-problem c4-editor__field-problem--error', hidden: true });
    control.setAttribute('aria-describedby', [hint && hint.id, problemLine.id].filter(Boolean).join(' '));
    const element = dom.el('div', { class: 'c4-editor__field' }, [
      dom.el('label', { for: spec.id, class: 'c4-editor__field-label', text: spec.label }), hint, control, problemLine]);
    return {
      element,
      control,
      showProblem(text) {
        problemLine.textContent = text;
        problemLine.hidden = false;
        control.setAttribute('aria-invalid', 'true');
        control.focus();
        return { ok: false };
      },
      clearProblem() {
        problemLine.hidden = true;
        control.removeAttribute('aria-invalid');
      },
    };
  }

  /** The Position select's choices: every insertion place, in reading order, by its index among `places`. */
  function placeChoices(places) {
    return places.map((place, index) => ({ value: String(index), label: place.label }));
  }

  /** The index among `places` of the place at `position` (the one the form starts on), or 0. */
  function placeIndex(places, position) {
    const at = places.findIndex((place) => samePosition(place.position, position));
    return Math.max(at, 0);
  }

  function samePosition(a, b) {
    return Boolean(a && b) && a.index === b.index && JSON.stringify(a.containerPath) === JSON.stringify(b.containerPath);
  }

  function choicesOf(people, emptyLabel) {
    return (emptyLabel ? [{ value: '', label: emptyLabel }] : []).concat(people.map((person) => ({ value: person.id, label: person.name })));
  }

  /**
   * The step form of a dynamic canvas: `createStepForm(kit)` gives this editor's `open(initial, placement)`, which the
   * C4 model adapter calls for the dynamic view module's plan of the form `step` (its fields are listed at the head of
   * c4-editor-uml-dynamic.js). `kit` is the canvas's form kit (`dom`, `ids`, `announce`, `state`, `actions` with
   * `openAnchoredForm`). It resolves `initial` with the learner's choices written over it (`from`, `to`, `at`,
   * `description`, `connector`), or null when Escape or Cancel closes it ("No step added.").
   */
  function createStepForm(kit) {
    const { dom, ids, actions, announce, state } = kit;
    return function openStepForm(initial, placement = {}) {
      const id = (part) => ids(`step-form-${part}`);
      const senders = initial.senders || [];
      // The receivers `stepEnds` allows for `from`; a step being edited keeps its current receiver listed, so the form
      // tells the truth about it (the scenario form's receiver picker does the same).
      const receiversOf = (from) => {
        const listed = (initial.receivers && initial.receivers[from]) || [];
        if (!initial.to || from !== initial.from || listed.some((each) => each.id === initial.to)) return listed;
        const element = state.getDesign().model.elements.get(initial.to);
        return listed.concat([{ id: initial.to, name: element ? element.name : initial.to }]);
      };
      const sender = formControl(dom, { id: id('from'), label: 'Sender', control: 'select', value: initial.from || '',
        choices: choicesOf(senders, initial.from ? null : 'Choose the sender…') });
      const receiver = formControl(dom, { id: id('to'), label: 'Receiver', control: 'select', value: initial.to || '',
        choices: choicesOf(receiversOf(initial.from), initial.to ? null : (initial.from ? 'Choose the receiver…' : 'Choose the sender first')) });
      sender.control.addEventListener('change', () => {
        replaceOptions(receiver.control, choicesOf(receiversOf(sender.control.value), sender.control.value ? 'Choose the receiver…' : 'Choose the sender first'));
      });
      const places = initial.places || [];
      const position = places.length > 0 ? formControl(dom, { id: id('position'), label: 'Position', control: 'select',
        value: String(placeIndex(places, initial.position)), choices: placeChoices(places) }) : null;
      const description = formControl(dom, { id: id('description'), label: 'Description', control: 'text', value: initial.description,
        hint: STEP_WORDS.descriptionHint });
      const connector = initial.connector ? connectorControl(kit, id, initial.connector) : null;
      const body = dom.el('div', { class: 'c4-editor__fields' }, [
        dom.el('div', { class: 'c4-editor__step-ends' }, [sender.element, receiver.element]),
        position && position.element, description.element, connector && connector.element,
      ]);
      const returnFocus = placement.returnFocus || body.ownerDocument.activeElement;
      return actions.openAnchoredForm({
        body, title: initial.mode === 'edit' ? 'Edit the step' : 'Add a step', placement, returnFocus,
        initialFocus: initial.from ? (initial.to ? description.control : receiver.control) : sender.control,
        submitLabel: initial.mode === 'edit' ? 'Save the step' : 'Add the step',
        onSubmit() {
          [sender, receiver, description].forEach((field) => field.clearProblem());
          if (sender.control.value === '') return sender.showProblem(STEP_WORDS.noSender.replace(/^Error: /, ''));
          if (receiver.control.value === '') return receiver.showProblem(STEP_WORDS.noReceiver.replace(/^Error: /, ''));
          if (description.control.value.trim() === '') return description.showProblem(STEP_WORDS.noDescription.replace(/^Error: /, ''));
          return Object.assign({}, initial, {
            from: sender.control.value, to: receiver.control.value, description: description.control.value.trim(),
            at: position ? places[Number(position.control.value)].at : initial.at,
            connector: connector ? Object.assign({}, initial.connector, { value: connector.value() }) : null,
          });
        },
      }).then((answer) => {
        if (answer) return answer;
        if (connector && connector.opening()) {
          state.select({ relationshipId: initial.connector.relationshipId });
          announce(`${NOT_ADDED.step} The relationship it runs along is shown in the inspector.`, { kind: 'result' });
        } else {
          announce(NOT_ADDED.step, { kind: 'result' });
        }
        return null;
      });
    };
  }

  /**
   * The step form's connector (spec §5.3, "Make a message asynchronous or synchronous"): the relationship's connector
   * by default ("Follows the relationship: call"); another choice shows its warning, with a button that closes the
   * form and opens the relationship. Returns `{ element, value(), opening() }`.
   */
  function connectorControl(kit, id, field) {
    const { dom } = kit;
    const select = formControl(dom, { id: id('connector'), label: 'Connector', control: 'select', value: field.value === null ? '' : field.value,
      choices: field.options.map((option) => ({ value: option.value === null ? '' : option.value, label: option.label })) });
    const warning = dom.el('p', { id: id('connector-warning'), class: 'c4-editor__field-problem c4-editor__field-problem--warning', hidden: true });
    let opening = false;
    const open = dom.el('button', { type: 'button', class: 'c4-editor__button', hidden: true, text: 'Open the relationship',
      on: { click: () => {
        opening = true;
        open.closest('dialog').close('');
      } } });
    const show = () => {
      const text = select.control.value === '' ? null : field.warnings[select.control.value] || null;
      warning.textContent = text ? `Warning: ${text}` : '';
      warning.hidden = !text;
      open.hidden = !text;
    };
    select.control.setAttribute('aria-describedby', `${select.control.getAttribute('aria-describedby')} ${warning.id}`);
    select.control.addEventListener('change', show);
    show();
    return {
      element: dom.el('div', { class: 'c4-editor__fields' }, [select.element, warning, open]),
      value: () => (select.control.value === '' ? null : select.control.value),
      opening: () => opening,
    };
  }

  /**
   * The fragment form of a dynamic canvas: `createFragmentForm(kit)` gives this editor's `open(initial, placement)` for
   * the dynamic view module's plan of the form `fragment`: Operator, Guard, and Position for a new fragment; Operator,
   * Guard, and the last step to include for "Wrap in a fragment…". It resolves `initial` with `operator`, `guard`, and
   * `at` or `last` written over it, or null when Escape or Cancel closes it ("No fragment added.").
   */
  function createFragmentForm(kit) {
    const { dom, ids, actions, announce } = kit;
    return function openFragmentForm(initial, placement = {}) {
      const id = (part) => ids(`fragment-form-${part}`);
      const operators = initial.operators || Object.keys(FRAGMENT_LABELS);
      const operator = formControl(dom, { id: id('operator'), label: 'Operator', control: 'select', value: initial.operator || operators[0],
        choices: operators.map((each) => ({ value: each, label: FRAGMENT_LABELS[each] || each })) });
      const guard = formControl(dom, { id: id('guard'), label: 'Guard', control: 'text', value: initial.guard, hint: STEP_WORDS.guardHint });
      const wrap = initial.mode === 'wrap';
      const places = initial.places || [];
      const where = wrap
        ? formControl(dom, { id: id('last'), label: 'Last step to include', control: 'select', value: String(initial.last),
          choices: initial.lastChoices.map((choice) => ({ value: String(choice.index), label: choice.label })) })
        : (places.length > 0 ? formControl(dom, { id: id('position'), label: 'Position', control: 'select',
          value: String(placeIndex(places, initial.position)), choices: placeChoices(places) }) : null);
      const body = dom.el('div', { class: 'c4-editor__fields' }, [operator.element, guard.element, where && where.element]);
      const returnFocus = placement.returnFocus || body.ownerDocument.activeElement;
      return actions.openAnchoredForm({
        body, title: wrap ? 'Wrap in a fragment' : 'Add a fragment', placement, returnFocus, initialFocus: operator.control,
        submitLabel: wrap ? 'Wrap the steps' : 'Add the fragment',
        onSubmit() {
          guard.clearProblem();
          if (guard.control.value.trim() === '') return guard.showProblem(STEP_WORDS.noGuard.replace(/^Error: /, ''));
          const answer = { operator: operator.control.value, guard: guard.control.value.trim() };
          if (wrap) answer.last = Number(where.control.value);
          else if (where) answer.at = places[Number(where.control.value)].at;
          return Object.assign({}, initial, answer);
        },
      }).then((answer) => {
        if (!answer) announce(NOT_ADDED.fragment, { kind: 'result' });
        return answer;
      });
    };
  }

  /** Replaces a select's options in place, so choosing a sender keeps the rest of the form as typed. */
  function replaceOptions(select, choices) {
    if (!select) return;
    select.replaceChildren(...choices.map((choice) => {
      const option = select.ownerDocument.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      return option;
    }));
  }

  return { createScenarioForms, createStepForm, createFragmentForm };
});
