(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return {
        state: require('./c4-editor-state.js'),
        lists: require('./c4-editor-lists.js'),
        panels: require('./c4-editor-panels.js'),
        interfaces: require('./c4-editor-interfaces.js'),
        inspectorShared: require('./c4-editor-inspector-shared.js'),
        inspectorFocus: require('./c4-editor-inspector-focus.js'),
        inspectorKit: require('./c4-editor-inspector-kit.js'),
        inspectorIdentity: require('./c4-editor-inspector-identity.js'),
        inspectorResponsibilities: require('./c4-editor-inspector-responsibilities.js'),
        inspectorChoices: require('./c4-editor-inspector-choices.js'),
        inspectorRelationships: require('./c4-editor-inspector-relationships.js'),
        inspectorPosition: require('./c4-editor-inspector-position.js'),
        inspectorRecords: require('./c4-editor-inspector-records.js'),
      };
    }, function () { return require('../c4-yaml.js'); });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspector = factory(function () { return root.ArchUMLC4EditorParts; },
      function () { return (root.ArchUMLC4Parts || {}).yaml || null; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts, coreYaml) {
  'use strict';

  // The inspector (spec §9.1): the form of whatever the state has selected. An element shows Basics,
  // Responsibilities, Collaborators, Relationships in this view, Position, Design choices, More, and Decisions
  // affecting it; a relationship shows its fields (the shared relationship-fields builder, Ruling 6), the interfaces
  // it uses (the Uses picker of c4-editor-interfaces.js), and choices; a derived edge shows the relationships it is
  // drawn from, the union of their uses, and "Add a summary relationship"; a code element adds Members.
  // Systems, containers, and components show Interfaces, and an interface selection shows the interface form; both
  // are built by c4-editor-interfaces.js from the same kit (spec §9.5).
  // Scenarios, deployment environments and nodes, decisions, requirements, groups, and custom views have their own forms
  // (`createRecordForms`, c4-editor-inspector-records.js). The inspector reads the
  // model through the facade and the state, and writes through the state's `dispatch` and the actions module
  // (Ruling 5), except the edits the core has no command for yet, which `createSpliceWriter` applies as one source
  // change through `state.applySourceText` (the host hears reason 'source'). It re-renders from the state's events, keeping focus and an unsaved draft across re-renders
  // (Review Focus 2). Sibling parts (`lists`, `panels`, `state`) are read at call time (Ruling 13).
  //
  // This file creates one inspector from its parts and chooses the form to show. The parts share one context object,
  // `inspector`, which each joins as it is created: the render cycle (c4-editor-inspector-focus.js), the form kit
  // (-kit), and the element form's sections: Basics and More (-identity), Responsibilities (-responsibilities), Design
  // choices and Decisions (-choices), Collaborators, Relationships in this view, and the relationship forms
  // (-relationships), and Position (-position). The DOM-free helpers they share are in -shared.

  const EVENTS = ['text', 'selection', 'diagnostics', 'view', 'mode'];

  /**
   * Creates the inspector in `region` (the inspector region's body). `context`: `state`, `dom`, `ids`, `announce`,
   * `host`, `options` (`profile`, `scaffolds`, `lockedFields`, `readOnly`), `actions` (the shared commands, which the
   * Name fields of an element, a node, and an interface rename through), and `layout`. Returns
   * `{ element, destroy(), openInterfaceForm(interfaceId, options), registerRevealStep(reveal) }`; the forms reach
   * `registerRevealStep` through the shared context too.
   */
  function createInspector(region, context) {
    const parts = editorParts();
    const { state, dom, ids, actions } = context;
    const options = context.options || {};
    const announce = context.announce || (() => {});
    const element = dom.el('div', { class: 'c4-editor__inspector' });
    region.appendChild(element);
    const { TYPE_FIELDS, TEXT, hasInterfacesSection, createSpliceWriter } = parts.inspectorShared;

    // The scenario form's reveal of a selected step (plan Task 42): the function it registers, or null.
    let revealStep = null;

    // The context every part of this inspector shares; the render cycle and the kit join it first, then each section.
    const inspector = {
      state, dom, ids, announce, options, actions, element, content, resolveFocusPath, registerRevealStep,
      view: { openDisclosures: new Set() },
      // Refusals shown under a field until the next render.
      localProblems: new Map(),
    };
    Object.assign(inspector, parts.inspectorFocus.createRenderCycle(inspector));
    const unsubscribers = EVENTS.map((event) => state.on(event, inspector.scheduleRender));
    Object.assign(inspector, parts.inspectorKit.createFormKit(inspector), { splices: createSpliceWriter(state, coreYaml) });
    const { scheduleRender, render, disposeOnRender, requestFocus, byKey, teardown, field, formSection, disclosure, openDisclosure,
      button, listEditor, textList, run, problem, problemsFor, problemText, lockReason, touchesLock, addRowUnlessLocked,
      splices } = inspector;
    const records = parts.inspectorRecords.createRecordForms(inspector);
    const interfaces = parts.interfaces.createInterfaceForms({
      state, dom, ids, announce, options, field, formSection, disclosure, openDisclosure, button, listEditor, textList, run,
      problem, problemsFor, problemText, lockReason, touchesLock, addRowUnlessLocked, requestFocus, scheduleRender, byKey, splices,
      disposeOnRender, lockedText: TEXT.locked,
      // The interface form's Name field renames through the shared command (UML-view editing spec §5.1). The mount
      // passes null actions when their part is absent, and creating the inspector must not throw then.
      renameInterface: actions ? actions.renameInterface : null,
      // Dialogs mount in the editor root so they also show in full screen.
      dialogRoot: region.closest('.c4-editor') || region,
    });
    [parts.inspectorIdentity.createIdentitySections, parts.inspectorResponsibilities.createResponsibilitiesSection,
      parts.inspectorChoices.createChoicesSections, parts.inspectorRelationships.createRelationshipSections,
      parts.inspectorPosition.createPositionSection].forEach((create) => Object.assign(inspector, create(inspector)));
    const { readOnlyReason, basicsSection, typeLine, moreBody, responsibilitiesSection, choicesBody, decisionsSection,
      collaboratorsSection, relationshipsInViewSection, relationshipForm, derivedForm, positionBody } = inspector;
    render();

    function content() {
      const selection = state.getSelection();
      const model = state.getDesign().model;
      const notice = state.isReadOnly() ? dom.el('p', { class: 'c4-editor__inspector-notice', text: readOnlyReason() }) : null;
      if (!selection || !model) return [notice, emptyMessage()];
      if (selection.relationshipId) return [notice, relationshipForm(model, selection.relationshipId)];
      if (selection.edgeId) return [notice, derivedForm(model, selection)];
      if (selection.elementId && model.elements.has(selection.elementId)) return [notice, elementForm(model, model.elements.get(selection.elementId))];
      if (selection.interfaceId) return [notice, interfaces.formFor(model, selection) || emptyMessage()];
      const record = records.formFor(model, selection);
      if (record && selection.step) handStepOn(selection);
      return [notice, record || emptyMessage()];
    }

    /**
     * Lets the scenario form reveal and mark the row of a selected step (UML-view editing spec §7.6): `reveal(selection)`
     * is called with each step selection, `{ scenarioId, step: { containerPath, index } }`, once the form showing it is
     * on the page. Returns a function that takes the registration back.
     */
    function registerRevealStep(reveal) {
      revealStep = reveal;
      return () => {
        if (revealStep === reveal) revealStep = null;
      };
    }

    /** Hands a step selection to the registered reveal after this render has put the scenario form in place. */
    function handStepOn(selection) {
      if (revealStep === null) return;
      const reveal = revealStep;
      Promise.resolve().then(() => {
        if (state.getSelection() === selection) reveal(selection);
      });
    }

    /** The interface form's resolution of a focus request (Problems › Show) for the render cycle. */
    function resolveFocusPath(selection, path) {
      return interfaces.resolveFocusPath(selection, path);
    }

    function emptyMessage() {
      return dom.el('p', { class: 'c4-editor__inspector-empty', tabindex: '-1', 'data-c4-focus-key': 'empty', text: TEXT.empty });
    }

    // ---- Element form --------------------------------------------------------------------------

    function elementForm(model, current) {
      const allows = (field) => TYPE_FIELDS[current.type].includes(field);
      return dom.el('div', { class: 'c4-editor__inspector-form' }, [
        dom.el('h3', { class: 'c4-editor__inspector-title', tabindex: '-1', 'data-c4-focus-key': 'title', text: current.name }),
        dom.el('p', { class: 'c4-editor__inspector-subtitle', text: typeLine(model, current) }),
        elementProblems(current),
        basicsSection(current, allows),
        allows('responsibilities') ? responsibilitiesSection(current) : null,
        current.type === 'code' ? records.membersSection(model, current) : null,
        collaboratorsSection(model, current),
        relationshipsInViewSection(model, current),
        disclosure('position', 'Position', () => positionBody(model, current)),
        allows('choices') ? disclosure('choices', 'Design choices',
          () => choicesBody(current.choices, current.path.concat('choices'), { elementId: current.id })) : null,
        hasInterfacesSection(current) ? interfaces.section(model, current) : null,
        disclosure('more', 'More', () => moreBody(model, current, allows)),
        decisionsSection(model, current),
      ]);
    }

    /** Diagnostics about the element as a whole (no field of the form holds them). */
    function elementProblems(current) {
      return problemText(ids('insp-element-problem'), problemsFor('element', current.path, { exact: true }));
    }

    // ---- Lifecycle -----------------------------------------------------------------------------

    function destroy() {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      teardown();
      interfaces.destroy();
      element.remove();
    }

    return {
      element,
      destroy,
      /** Opens the interface form; see `open` in c4-editor-interfaces.js (the interface card's "Edit <operation>"). */
      openInterfaceForm: (interfaceId, openOptions) => interfaces.open(interfaceId, openOptions),
      registerRevealStep,
    };
  }

  return { createInspector: createInspector };
});
