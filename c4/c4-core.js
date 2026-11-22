(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-schema.js'), require('./c4-yaml.js'), require('./c4-model.js'),
      require('./c4-projection.js'), require('./c4-checks.js'), require('./c4-query.js'), require('./c4-constraints.js'),
      require('./c4-edit.js'), require('./c4-edit-references.js'), require('./c4-describe.js'), require('./c4-uml.js'));
  } else {
    var parts = root.ArchUMLC4Parts;
    root.ArchUMLC4 = factory(parts.schema, parts.yaml, parts.model, parts.projection, parts.checks, parts.query,
      parts.constraints, parts.edit, parts.editReferences, parts.describe, parts.uml);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, yamlAdapter, modelApi, projection, checks, query, constraints, edit,
  references, describer, umlText) {
  'use strict';

  // The public facade of the DOM-free core (spec §3): every surface (renderer, editor, tutorial, CLI) calls
  // these functions with a `design` returned by `load`, never the modules behind them.

  var VERSION = '1.1.0';

  /** Reads `text` into a design `{ text, parsed, model, diagnostics }`; `model` is null while the YAML has errors. */
  function load(text, options) {
    var parsed = yamlAdapter.parse(text);
    var normalized = modelApi.normalize(parsed, { source: options && options.source });
    return { text: text, parsed: parsed, model: normalized.model, diagnostics: normalized.diagnostics };
  }

  /**
   * Structural and semantic diagnostics with the configuration applied (`disable`, `severity`, `thresholds`,
   * `hideInfo`, `suppressIncompleteFor`, `honorFileIgnores`). An unreadable design has only its syntax errors.
   */
  function check(design, options) {
    if (isUnreadable(design)) return design.diagnostics;
    var settings = Object.assign({}, options, { parsed: design.parsed });
    var found = design.diagnostics.concat(checks.run(design.model, settings));
    return checks.applyConfig(found, design.model, settings);
  }

  // A design whose YAML cannot be read has no model. The functions below answer for it without throwing: no views,
  // no default view, no dependents or steps, and `project` returns an error view carrying the syntax diagnostics
  // (spec §7.3), so every host can show the same accessible error figure.

  function isUnreadable(design) {
    return design.model === null;
  }

  /** The listed views; `{ interfaces: true }` adds the interface views (spec §5.1). */
  function listViews(design, options) {
    return isUnreadable(design) ? [] : projection.listViews(design.model, { interfaces: Boolean(options && options.interfaces) });
  }

  /** The selector an embed opens without `view:`, or null while the YAML cannot be read. */
  function defaultView(design) {
    return isUnreadable(design) ? null : projection.defaultView(design.model);
  }

  function project(design, selector) {
    if (isUnreadable(design)) return projection.errorView(selector ? schema.selectorKey(selector) : null, design.diagnostics);
    return projection.projectView(design.model, selector);
  }

  /** The classified steps of a scenario; none for a scenario the design does not have or cannot be read. */
  function classifySteps(design, scenarioId) {
    if (isUnreadable(design) || !design.model.scenarios.has(scenarioId)) return [];
    return projection.classifySteps(design.model, scenarioId);
  }

  /** The accessible text of a view; `{ panels: 'syntax' }` leaves out the semantic panels of an interface card. */
  function describe(viewModel, options) {
    return describer.describe(viewModel, options);
  }

  /** The ArchUML text of a UML-notation view with its `ids` and source map (UML-view editing spec §4.1). */
  function toUml(viewModel) {
    return umlText.toUml(viewModel);
  }

  /** The step position `{ containerPath, index }` an insertion anchor of a dynamic view's text stands for, or null. */
  function positionForAnchor(source, beforeLine) {
    return umlText.positionForAnchor(source, beforeLine);
  }

  var queryApi = {
    validate: function (predicate, options) { return query.validatePredicate(predicate, options); },
    /** Grades `design`; a `checks:` predicate runs `check(design, config)` unless the host passes its own `checks`. */
    evaluate: function (design, predicate, context) {
      var withChecks = Object.assign({ checks: function (model, config) { return check(design, config); } }, context);
      return query.evaluate(design.model, predicate, withChecks);
    },
  };

  function dependentsOf(design, elementId) {
    return isUnreadable(design) ? [] : edit.dependentsOf(design, elementId);
  }

  /** The interfaces an element provides and requires (spec §5.3 rule 2); empty for an unknown element. */
  function interfacesOf(design, elementId) {
    if (isUnreadable(design) || !design.model.elements.has(elementId)) return { provided: [], required: [] };
    return {
      provided: projection.providedInterfaces(design.model, elementId),
      required: projection.requiredInterfaces(design.model, elementId),
    };
  }

  // How the interface of a relationship from S to T relates to T, by the kind decision J7 gives the use.
  function relationOf(model, kind, providerId, targetId) {
    if (kind === 'emit') return 'emitted';
    if (kind !== 'request') return kind;
    if (providerId === targetId) return 'target';
    return constraints.isInside(model, providerId, targetId) ? 'inside-target' : 'entered';
  }

  /**
   * The interfaces a relationship from `sourceId` to `targetId` may use (spec §4.11, decision J7), in document order,
   * each with its operations and its `relation` to the target. An in-process interface is left out for a source that
   * runs in another container, because a component is not separately deployable.
   */
  function usableInterfaces(design, { sourceId, targetId }) {
    if (isUnreadable(design)) return [];
    const { model } = design;
    if (!model.elements.has(sourceId) || !model.elements.has(targetId)) return [];
    return [...model.interfaces.values()].flatMap((declared) => {
      const kind = modelApi.useKind(model, sourceId, targetId, declared.id);
      if (kind === null) return [];
      if (kind === 'request' && checks.isInProcessAcrossBoundary(model, declared, sourceId)) return [];
      return [{
        interfaceId: declared.id,
        name: declared.name,
        providerId: declared.providerId,
        providerName: model.elements.get(declared.providerId).name,
        relation: relationOf(model, kind, declared.providerId, targetId),
        operations: declared.operations.map((operation) => ({ id: operation.id, syntax: operation.syntax, realizes: operation.realizes })),
      }];
    });
  }

  /** The `uses` entries (of relationships and scenario steps) that name the interface, in document order. */
  function interfaceDependentsOf(design, interfaceId) {
    return isUnreadable(design) ? [] : edit.interfaceDependentsOf(design, interfaceId);
  }

  /**
   * The stored view selectors that open the interface's description card (`interface ‹id›` in any letter case): the
   * initial `view` and each custom view's `view`, in document order, as `{ path, label }`. With interfaceDependentsOf,
   * it tells whether anything refers to an interface (UML-view editing spec §5.1).
   */
  function interfaceSelectorsOf(design, interfaceId) {
    return isUnreadable(design) ? [] : references.interfaceSelectorsOf(design, interfaceId);
  }

  // Rules the forms and the canvases share (UML-view editing spec §4.3), owned by c4-constraints.js.

  /**
   * The ends a step may have at `index` of a scenario's step list: `{ froms, tosOf(from), problemOf(from, to) }`
   * (c4-constraints.js `stepEnds`). A design that cannot be read offers none.
   */
  function stepEnds(design, options) {
    return isUnreadable(design) ? constraints.noStepEnds() : constraints.stepEnds(design.model, options);
  }

  /** The sender choices of an existing step: every element that sends or answers along some relationship. */
  function structuralSenders(design) {
    return isUnreadable(design) ? [] : constraints.structuralSenders(design.model);
  }

  /**
   * Null, or why `sourceId` cannot `extends` or `implements` `targetId` by the kind rule: `extends-target`,
   * `extends-kind`, `implements-target`, or `extends-cycle`. A design that cannot be read names no code element.
   */
  function inheritanceProblem(design, sourceId, relation, targetId) {
    return isUnreadable(design) ? 'extends-target' : constraints.inheritanceProblem(design.model, sourceId, relation, targetId);
  }

  /** The initial view selector an embed names with its top-level `view:` key, or null; `text` is the embed unchanged. */
  function extractEmbed(text) {
    var parsed = yamlAdapter.parse(text);
    var data = parsed.errors.length === 0 ? yamlAdapter.toData(parsed) : null;
    var selector = data && typeof data === 'object' && typeof data.view === 'string' ? data.view : null;
    return { selector: selector, text: text };
  }

  var rules = checks.RULES.map(function (rule) {
    var metadata = Object.assign({}, rule);
    delete metadata.check;
    return metadata;
  });

  return {
    version: VERSION,
    SCHEMA_VERSION: schema.SCHEMA_VERSION,
    load: load,
    check: check,
    listViews: listViews,
    defaultView: defaultView,
    project: project,
    classifySteps: classifySteps,
    describe: describe,
    toUml: toUml,
    positionForAnchor: positionForAnchor,
    query: queryApi,
    edit: function (design, command) { return edit.apply(design, command); },
    dependentsOf: dependentsOf,
    interfacesOf: interfacesOf,
    usableInterfaces: usableInterfaces,
    interfaceDependentsOf: interfaceDependentsOf,
    interfaceSelectorsOf: interfaceSelectorsOf,
    isNested: constraints.isNested,
    stepEnds: stepEnds,
    structuralSenders: structuralSenders,
    inheritanceProblem: inheritanceProblem,
    extractEmbed: extractEmbed,
    rules: rules,
    toJsonSchema: schema.toJsonSchema,
  };
});
