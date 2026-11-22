(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-projection.js'), require('./c4-checks.js'), require('./c4-schema.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.query = factory(parts.projection, parts.checks, parts.schema);
  }
})(typeof self !== 'undefined' ? self : this, function (projection, checks, schema) {
  'use strict';

  // Tutorial predicates (spec §8): `validatePredicate` finds author errors (unknown keys, malformed selector syntax,
  // a checks predicate that can never reach its asserted severity); `evaluate` grades a learner's model. Anything
  // the learner's model lacks (a view, a scenario, an element) is a failed predicate with a learner-facing message.

  const PRESENCE = ['present', 'absent'];
  const DERIVED_MODES = ['include', 'exclude', 'only'];
  const RESPONSIBILITY_KINDS = ['know', 'do', 'decide'];
  const ASSERTIONS = ['exists', 'absent', 'count', 'every', 'checks', 'view', 'same_as_seed'];
  const COMPARATORS = ['equals', 'at_least', 'at_most'];
  const QUERIES = ['element', 'relationship', 'responsibility', 'step', 'requirement', 'interface', 'operation'];
  const USES_INTERFACE_MODES = ['present', 'absent', 'whole'];
  const VALUES_MODES = ['present', 'absent', 'meaningful'];
  const SEED_PARTS = ['all', 'syntax'];
  const SHOWN_BOUNDARY_KINDS = ['scope', 'system'];
  const MAX_LISTED_FINDINGS = 3;

  // ---- Text matching -------------------------------------------------------------------------

  /** Case-insensitive text with whitespace and hyphens folded to single spaces (spec §8 text matching). */
  function normalizeText(text) {
    return String(text).toLowerCase().replace(/[-\s]+/g, ' ').trim();
  }

  function mentionsAny(text, needles) {
    const haystack = normalizeText(text || '');
    return needles.some((needle) => haystack.includes(normalizeText(needle)));
  }

  function sameText(a, b) {
    return normalizeText(a || '') === normalizeText(b || '');
  }

  // ---- Validation ----------------------------------------------------------------------------

  const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isText = (value) => typeof value === 'string' && value !== '';
  const isCount = (value) => Number.isInteger(value) && value >= 0;

  /** A validator checks one value and returns an error message, or null when the value is acceptable. */
  const text = (value) => (isText(value) ? null : 'must be a text');
  const textList = (value) => (Array.isArray(value) && value.length > 0 && value.every(isText) ? null : 'must be a list of texts');
  const boolean = (value) => (typeof value === 'boolean' ? null : 'must be true or false');
  const count = (value) => (isCount(value) ? null : 'must be a whole number, zero or more');
  const textOrList = (value) => (isText(value) || textList(value) === null ? null : 'must be a text or a list of texts');
  const oneOf = (values) => (value) => (values.includes(value) ? null : `must be one of ${values.join(', ')}`);

  function selectorSyntax(value) {
    if (!isText(value)) return 'must be a view selector text';
    const parsed = projection.parseSelector(value);
    return parsed.error ? `${JSON.stringify(value)} is not a view selector (${parsed.error})` : null;
  }

  /** One `<interface>` or `<interface>.<operation>` entry of a `uses` filter, or a list of them. */
  function usesReferences(value) {
    if (textOrList(value)) return 'must be an interface id, an interface.operation, or a list of them';
    return [].concat(value).every((entry) => !schema.parseUsesRef(entry).error)
      ? null : 'must name an interface or an interface.operation, such as enrollment-api.submit-plan';
  }

  const typeExpression = (value) => (isText(value) && !schema.parseTypeExpression(value).invalid ? null : 'must be a type expression');
  const typeExpressionList = (value) => (Array.isArray(value) && value.length > 0 && value.every((item) => typeExpression(item) === null)
    ? null : 'must be a list of type expressions');

  /** The key tables of the filters; nested filters are validated through `nested` after the tables are built. */
  const FILTERS = {};

  const nested = (name) => (value, path, errors) => validateFilter(name, value, path, errors);
  /** An interface id or an interface filter. */
  const interfaceRef = (value, path, errors) => (isText(value) ? null : validateFilter('interface', value, path, errors));
  /** An element id or an element filter. */
  const elementRef = (value, path, errors) => (isText(value) ? null : validateFilter('element', value, path, errors));
  const elementRefList = (value, path, errors) => {
    if (!Array.isArray(value) || value.length === 0) return 'must be a list of element ids or element filters';
    value.forEach((item, index) => elementRef(item, path.concat(index), errors));
    return null;
  };

  FILTERS.element = {
    label: 'an element filter',
    keys: {
      id: text, type: oneOf(schema.ELEMENT_TYPES), kind: text, name: text, name_any: textList, in: elementRef, parent: elementRef,
      external: boolean, technology: oneOf(PRESENCE), technology_any: textList, stereotype: text, pattern: text,
      pattern_role: text, style: text, owns_any: textList, has_responsibility: nested('responsibility'),
      responsibilities_at_least: count, provides_interface: nested('interface'),
    },
  };
  FILTERS.responsibility = {
    label: 'a responsibility filter',
    keys: { of: elementRef, id: text, kind: oneOf(RESPONSIBILITY_KINDS), text_any: textList, refines: text, leaf: boolean },
  };
  FILTERS.relationship = {
    label: 'a relationship filter',
    keys: {
      from: elementRef, to: elementRef, description_any: textList, technology: oneOf(PRESENCE), technology_any: textList,
      connector: oneOf(schema.CONNECTORS), derived: oneOf(DERIVED_MODES), in_view: selectorSyntax,
      uses: usesReferences, uses_interface: oneOf(USES_INTERFACE_MODES), requests: text,
    },
  };
  FILTERS.interface = {
    label: 'an interface filter',
    keys: { id: text, of: elementRef, in: elementRef, name_any: textList, style: text, has_operation: nested('operation'), used_by: elementRef },
  };
  FILTERS.operation = {
    label: 'an operation filter',
    keys: {
      id: text, of: interfaceRef, syntax_any: textList, purpose: oneOf(PRESENCE), side_effects: oneOf(PRESENCE),
      restrictions: oneOf(PRESENCE), errors_at_least: count, examples_at_least: count, realizes: textOrList,
      realizes_any: textList, realizes_at_least: count, input_has_field: nested('field'), output_has_field: nested('field'),
    },
  };
  FILTERS.field = {
    label: 'a field filter',
    keys: {
      name_any: textList, type: typeExpression, type_any: typeExpressionList, meaning: oneOf(PRESENCE), unit: oneOf(PRESENCE),
      format: oneOf(PRESENCE), constraints: oneOf(PRESENCE), values: oneOf(VALUES_MODES), unit_any: textList,
    },
  };
  FILTERS.seedInterface = {
    label: 'an interface same_as_seed',
    required: ['interface'],
    keys: { interface: nested('interface'), part: oneOf(SEED_PARTS) },
  };
  FILTERS.step = {
    label: 'a step query',
    required: ['scenario'],
    keys: { scenario: text, from: elementRef, to: elementRef, in_fragment: oneOf(schema.FRAGMENTS), reply: boolean },
  };
  FILTERS.requirement = {
    label: 'a requirement query',
    keys: { id: text, kind: oneOf(schema.REQUIREMENT_KINDS), text_any: textList },
  };
  FILTERS.view = {
    label: 'a view assertion',
    required: ['view'],
    keys: { view: selectorSyntax, shows: elementRefList, hides: elementRefList, max_elements: count },
  };
  FILTERS.checks = {
    label: 'a checks assertion',
    keys: { max_errors: count, max_warnings: count, rules: textList, categories: textList, disable: textList },
  };

  function addError(errors, path, message) {
    errors.push({ path, message });
  }

  function misspelled(key, candidates) {
    const suggestion = schema.suggest(key, candidates);
    return suggestion ? `; did you mean ${suggestion}?` : `; use ${candidates.join(', ')}`;
  }

  /** Checks a map against a key table: unknown keys (with a suggestion), missing required keys, and each value. */
  function validateFilter(name, value, path, errors) {
    const { label, keys, required = [] } = FILTERS[name];
    if (!isMap(value)) {
      addError(errors, path, `${label} must be a map`);
      return null;
    }
    Object.keys(value).forEach((key) => {
      if (!(key in keys)) {
        addError(errors, path.concat(key), `Unknown key ${key} in ${label}${misspelled(key, Object.keys(keys))}`);
        return;
      }
      const problem = keys[key](value[key], path.concat(key), errors);
      if (problem) addError(errors, path.concat(key), `${key} in ${label} ${problem}`);
    });
    required.forEach((key) => {
      if (!(key in value)) addError(errors, path, `${label} needs ${key}`);
    });
    return null;
  }

  /** The key of the one entry of `value` named in `allowed`, or null with an error when there is not exactly one. */
  function singleKey(value, allowed, path, errors, what) {
    const present = allowed.filter((key) => key in value);
    if (present.length !== 1) {
      addError(errors, path, `${what} needs exactly one of ${allowed.join(', ')}`);
      return null;
    }
    return present[0];
  }

  function validateQuery(query, path, errors) {
    if (!isMap(query)) {
      addError(errors, path, 'a query must be a map with one of ' + QUERIES.join(', '));
      return;
    }
    const unknown = Object.keys(query).filter((key) => !QUERIES.includes(key));
    unknown.forEach((key) => addError(errors, path.concat(key), `Unknown query ${key}${misspelled(key, QUERIES)}`));
    if (unknown.length > 0) return;
    const kind = singleKey(query, QUERIES, path, errors, 'a query');
    if (kind) validateFilter(kind, query[kind], path.concat(kind), errors);
  }

  /** The rules a checks assertion selects: those named by `rules` or `categories` (all without either), minus `disable`. */
  function selectedRules(spec, config) {
    const named = spec.rules || [];
    const categories = spec.categories || [];
    const disabled = new Set((config.disable || []).concat(spec.disable || []));
    const selectsAll = named.length === 0 && categories.length === 0;
    return checks.RULES.filter((rule) => (selectsAll || named.includes(rule.id) || categories.includes(rule.category))
      && !disabled.has(rule.id));
  }

  function configuredSeverity(rule, config) {
    return (config.severity && config.severity[rule.id]) || rule.severity;
  }

  function validateChecksReach(spec, config, path, errors) {
    const known = new Set(checks.RULES.map((rule) => rule.id));
    const categories = new Set(checks.RULES.map((rule) => rule.category));
    (spec.rules || []).filter((id) => !known.has(id)).forEach((id) => addError(errors, path.concat('rules'), `Unknown rule ${id}`));
    (spec.categories || []).filter((id) => !categories.has(id))
      .forEach((id) => addError(errors, path.concat('categories'), `Unknown category ${id}${misspelled(id, [...categories])}`));
    if (spec.max_errors === undefined && spec.max_warnings === undefined) {
      addError(errors, path, 'a checks assertion needs max_errors or max_warnings');
      return;
    }
    const selected = selectedRules(spec, config);
    [['max_errors', 'error'], ['max_warnings', 'warning']].filter(([key]) => spec[key] !== undefined).forEach(([key, severity]) => {
      if (selected.some((rule) => configuredSeverity(rule, config) === severity)) return;
      const listed = selected.map((rule) => `${rule.id} is ${configuredSeverity(rule, config)}`).join(', ') || 'no rule is selected';
      addError(errors, path.concat(key), `${key} can never fail: no selected rule reports at ${severity} severity in this step (${listed})`);
    });
  }

  function validateComparators(predicate, path, errors) {
    const present = COMPARATORS.filter((key) => key in predicate);
    if (predicate.count !== undefined && present.length !== 1) addError(errors, path, `count needs exactly one of ${COMPARATORS.join(', ')}`);
    COMPARATORS.filter((key) => key in predicate && !('count' in predicate)).forEach((key) =>
      addError(errors, path.concat(key), `${key} only goes with count`));
    COMPARATORS.filter((key) => key in predicate && !isCount(predicate[key]))
      .forEach((key) => addError(errors, path.concat(key), `${key} must be a whole number, zero or more`));
  }

  /** `same_as_seed` compares an interface (not elements) when it names `interface` or `part`. */
  const isInterfaceSeed = (value) => isMap(value) && ('interface' in value || 'part' in value);

  function validateAssertion(predicate, config, errors) {
    const modifiers = COMPARATORS.concat('satisfies');
    const unknown = Object.keys(predicate).filter((key) => !ASSERTIONS.includes(key) && !modifiers.includes(key));
    unknown.forEach((key) => addError(errors, [key], `Unknown key ${key} in a predicate${misspelled(key, ASSERTIONS)}`));
    if (unknown.length > 0) return;
    const assertion = singleKey(predicate, ASSERTIONS, [], errors, 'a predicate');
    validateComparators(predicate, [], errors);
    if ('satisfies' in predicate && assertion !== 'every') addError(errors, ['satisfies'], 'satisfies only goes with every');
    if (assertion === 'every' && !('satisfies' in predicate)) addError(errors, [], 'every needs satisfies');
    if (!assertion) return;
    const value = predicate[assertion];
    if (['exists', 'absent', 'count'].includes(assertion)) validateQuery(value, [assertion], errors);
    else if (assertion === 'same_as_seed') validateFilter(isInterfaceSeed(value) ? 'seedInterface' : 'element', value, [assertion], errors);
    else if (assertion === 'every') validateFilter('element', value, [assertion], errors);
    else validateFilter(assertion, value, [assertion], errors);
    if (assertion === 'every' && 'satisfies' in predicate) validateFilter('element', predicate.satisfies, ['satisfies'], errors);
    if (assertion === 'checks' && isMap(value)) validateChecksReach(value, config, ['checks'], errors);
  }

  /**
   * Finds author errors in a predicate. `options.checks` is the step's `c4.checks` configuration; it decides at which
   * severity each rule reports, so a checks assertion that no selected rule can fail is rejected as vacuous.
   */
  function validatePredicate(predicate, options = {}) {
    const errors = [];
    if (!isMap(predicate)) addError(errors, [], 'a predicate must be a map with one of ' + ASSERTIONS.join(', '));
    else validateAssertion(predicate, options.checks || {}, errors);
    return { ok: errors.length === 0, errors };
  }

  // ---- Evaluation: model access --------------------------------------------------------------

  /** A missing view, scenario, or element: the predicate fails with this message instead of being an author error. */
  class Unresolved extends Error {}

  function unresolved(message) {
    return new Unresolved(message);
  }

  const lineage = (model, element) => {
    const chain = [];
    for (let current = element; current; current = model.elements.get(current.parentId)) chain.push(current.id);
    return chain;
  };

  function isInside(model, element, ancestorId) {
    return element.id !== ancestorId && lineage(model, element).includes(ancestorId);
  }

  function allResponsibilities(model) {
    return [...model.elements.values()].flatMap((element) => element.responsibilities);
  }

  function responsibilityLabel(responsibility) {
    return responsibility.id || `${responsibility.ownerId}#${responsibility.index}`;
  }

  // ---- Evaluation: reference resolution ------------------------------------------------------

  function requireElement(model, id) {
    if (!model.elements.has(id)) throw unresolved(`unknown element ${id}`);
  }

  function requireElementRef(model, ref) {
    if (isText(ref)) requireElement(model, ref);
    else requireElementFilterRefs(model, ref);
  }

  /** Every id a filter names must resolve, so a typo in the learner's model cannot make a predicate pass vacuously. */
  function requireElementFilterRefs(model, filter) {
    if (filter.id !== undefined) requireElement(model, filter.id);
    ['in', 'parent'].filter((key) => filter[key] !== undefined).forEach((key) => requireElementRef(model, filter[key]));
    if (filter.has_responsibility) requireResponsibilityFilterRefs(model, filter.has_responsibility);
    if (filter.provides_interface) requireInterfaceFilterRefs(model, filter.provides_interface);
  }

  /** The interface an id names, ignoring case (spec §8); undefined when the model has none. */
  function findInterface(model, id) {
    return [...model.interfaces.values()].find((declared) => declared.id.toLowerCase() === id.toLowerCase());
  }

  function requireInterface(model, id) {
    const declared = findInterface(model, id);
    if (!declared) throw unresolved(`unknown interface ${id}`);
    return declared;
  }

  function requireOperationOf(model, interfaceId, operationId) {
    const declared = requireInterface(model, interfaceId);
    if (!declared.operations.some((operation) => operation.id === operationId)) throw unresolved(`unknown operation ${interfaceId}.${operationId}`);
  }

  function requireOperationAnywhere(model, operationId) {
    const known = [...model.interfaces.values()].some((declared) => declared.operations.some((operation) => operation.id === operationId));
    if (!known) throw unresolved(`unknown operation ${operationId}`);
  }

  function requireInterfaceFilterRefs(model, filter) {
    if (filter.id !== undefined) requireInterface(model, filter.id);
    ['of', 'in', 'used_by'].filter((key) => filter[key] !== undefined).forEach((key) => requireElementRef(model, filter[key]));
    if (filter.has_operation) requireOperationFilterRefs(model, filter.has_operation);
  }

  function requireOperationFilterRefs(model, filter) {
    if (isText(filter.of)) requireInterface(model, filter.of);
    else if (filter.of !== undefined) requireInterfaceFilterRefs(model, filter.of);
    if (filter.id !== undefined) {
      if (isText(filter.of)) requireOperationOf(model, filter.of, filter.id);
      else requireOperationAnywhere(model, filter.id);
    }
    [].concat(filter.realizes || [], filter.realizes_any || []).forEach((id) => requireResponsibility(model, id));
  }

  /** Every `uses` entry of a relationship filter must name an interface, and the operation when it gives one. */
  function requireUsesRefs(model, entries) {
    [].concat(entries).forEach((entry) => {
      const { interfaceId, operationId } = schema.parseUsesRef(entry);
      if (operationId === null) requireInterface(model, interfaceId);
      else requireOperationOf(model, interfaceId, operationId);
    });
  }

  function requireResponsibility(model, id) {
    if (!model.responsibilityById.has(id)) throw unresolved(`unknown responsibility ${id}`);
  }

  function requireResponsibilityFilterRefs(model, filter) {
    if (filter.of !== undefined) requireElementRef(model, filter.of);
    ['id', 'refines'].filter((key) => filter[key] !== undefined).forEach((key) => requireResponsibility(model, filter[key]));
  }

  function requireEndpointRefs(model, filter) {
    ['from', 'to'].filter((key) => filter[key] !== undefined).forEach((key) => requireElementRef(model, filter[key]));
  }

  /** The ids an element reference stands for: the element itself, or every element matching the filter. */
  function idsOfRef(model, ref) {
    if (isText(ref)) return new Set([ref]);
    return new Set(elementsMatching(model, ref).map((element) => element.id));
  }

  // ---- Evaluation: element and responsibility filters ----------------------------------------

  const ELEMENT_TESTS = {
    id: (model, element, id) => element.id === id,
    type: (model, element, type) => element.type === type,
    kind: (model, element, kind) => element.kind === kind,
    name: (model, element, name) => sameText(element.name, name),
    name_any: (model, element, names) => mentionsAny(element.name, names),
    in: (model, element, ref) => [...idsOfRef(model, ref)].some((id) => isInside(model, element, id)),
    parent: (model, element, ref) => idsOfRef(model, ref).has(element.parentId),
    external: (model, element, external) => Boolean(element.external) === external,
    technology: (model, element, presence) => Boolean(element.technology) === (presence === 'present'),
    technology_any: (model, element, needles) => mentionsAny(element.technology, needles),
    stereotype: (model, element, stereotype) => element.stereotypes.includes(stereotype),
    pattern: (model, element, pattern) => patternChoices(element).some((choice) => sameText(choice.pattern, pattern)),
    pattern_role: (model, element, role) => patternChoices(element).some((choice) => sameText(choice.role, role)),
    style: (model, element, style) => (element.choices ? element.choices.styles : []).some((candidate) => sameText(candidate, style)),
    owns_any: (model, element, needles) => element.owns.some((fact) => mentionsAny(fact, needles)),
    has_responsibility: (model, element, filter) => element.responsibilities.some((entry) => responsibilityMatches(model, entry, filter)),
    responsibilities_at_least: (model, element, least) => element.responsibilities.length >= least,
    provides_interface: (model, element, filter) => projection.providedInterfaces(model, element.id)
      .some((entry) => interfaceMatches(model, model.interfaces.get(entry.interfaceId), filter)),
  };

  function patternChoices(element) {
    return element.choices ? element.choices.patterns : [];
  }

  /** A pattern and its role are matched in the same entry when a filter names both. */
  function elementMatches(model, element, filter) {
    const entryTests = (filter.pattern !== undefined && filter.pattern_role !== undefined)
      ? patternChoices(element).some((choice) => sameText(choice.pattern, filter.pattern) && sameText(choice.role, filter.pattern_role))
      : true;
    return entryTests && Object.keys(filter).every((key) => ELEMENT_TESTS[key](model, element, filter[key]));
  }

  function elementsMatching(model, filter) {
    return [...model.elements.values()].filter((element) => elementMatches(model, element, filter));
  }

  function isRefined(model, responsibility) {
    return allResponsibilities(model).some((other) => other.refines.includes(responsibility.id));
  }

  const RESPONSIBILITY_TESTS = {
    of: (model, entry, ref) => idsOfRef(model, ref).has(entry.ownerId),
    id: (model, entry, id) => entry.id === id,
    kind: (model, entry, kind) => entry.kind === kind,
    text_any: (model, entry, needles) => mentionsAny(entry.text, needles),
    refines: (model, entry, id) => entry.refines.includes(id),
    leaf: (model, entry, leaf) => (entry.id ? !isRefined(model, entry) : true) === leaf,
  };

  function responsibilityMatches(model, entry, filter) {
    return Object.keys(filter).every((key) => RESPONSIBILITY_TESTS[key](model, entry, filter[key]));
  }

  // ---- Evaluation: relationships -------------------------------------------------------------

  /**
   * Relationship candidates: each declared relationship, and the relationships it implies between the elements
   * that enclose its ends (grouped per pair of elements, unless that pair has a declared relationship).
   */
  function relationshipCandidates(model) {
    const declared = model.relationships.map((relationship) => ({
      label: relationship.id, sourceId: relationship.sourceId, targetId: relationship.targetId, derived: false, members: [relationship] }));
    const declaredPairs = new Set(declared.map((candidate) => `${candidate.sourceId}->${candidate.targetId}`));
    const derived = new Map();
    model.relationships.forEach((relationship) => {
      const sources = lineage(model, model.elements.get(relationship.sourceId));
      const targets = lineage(model, model.elements.get(relationship.targetId));
      sources.forEach((sourceId) => targets.forEach((targetId) => {
        const key = `${sourceId}->${targetId}`;
        const nested = sources.includes(targetId) || targets.includes(sourceId);
        if (nested || declaredPairs.has(key)) return;
        if (!derived.has(key)) derived.set(key, { label: key, sourceId, targetId, derived: true, members: [] });
        derived.get(key).members.push(relationship);
      }));
    });
    return declared.concat([...derived.values()]);
  }

  /** The relationships drawn in a view: its edges, each with the declared relationships it stands for. */
  function viewCandidates(model, view) {
    const byId = new Map(model.relationships.map((relationship) => [relationship.id, relationship]));
    return view.edges.map((edge) => ({
      label: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, derived: edge.derived,
      members: edge.sources.map((id) => byId.get(id)) }));
  }

  /** The uses an edge stands for: a declared relationship's own, else those it summarizes; the merged sources' for a derived edge. */
  function usesOfCandidate(model, candidate) {
    return candidate.members.flatMap((member) => (candidate.derived || member.uses.length > 0 ? member.uses
      : projection.summarizedBy(model, member).flatMap((summarized) => summarized.uses)));
  }

  /** A `uses` entry matches a use of its interface; one naming an operation matches only a use of that operation. */
  function usesMatch(entry, use) {
    const { interfaceId, operationId } = schema.parseUsesRef(entry);
    return use.interfaceId.toLowerCase() === interfaceId.toLowerCase() && (operationId === null || use.operationId === operationId);
  }

  const USES_INTERFACE_TESTS = {
    present: (uses) => uses.length > 0,
    absent: (uses) => uses.length === 0,
    whole: (uses) => uses.some((use) => use.operationId === null),
  };

  const RELATIONSHIP_TESTS = {
    from: (model, candidate, ref) => idsOfRef(model, ref).has(candidate.sourceId),
    to: (model, candidate, ref) => idsOfRef(model, ref).has(candidate.targetId),
    description_any: (model, candidate, needles) => candidate.members.some((member) => mentionsAny(member.description, needles)),
    technology: (model, candidate, presence) => (presence === 'present'
      ? candidate.members.some((member) => member.technology) : candidate.members.every((member) => !member.technology)),
    technology_any: (model, candidate, needles) => candidate.members.some((member) => mentionsAny(member.technology, needles)),
    connector: (model, candidate, connector) => candidate.members.some((member) => member.connector === connector),
    derived: (model, candidate, mode) => mode === 'include' || candidate.derived === (mode === 'only'),
    in_view: () => true,
    uses: (model, candidate, entries) => [].concat(entries)
      .some((entry) => usesOfCandidate(model, candidate).some((use) => usesMatch(entry, use))),
    uses_interface: (model, candidate, mode) => USES_INTERFACE_TESTS[mode](usesOfCandidate(model, candidate)),
    requests: (model, candidate, id) => candidate.members.some((member) => member.requests.includes(id)),
  };

  function queryRelationships(model, filter) {
    requireEndpointRefs(model, filter);
    if (filter.uses !== undefined) requireUsesRefs(model, filter.uses);
    if (filter.requests !== undefined) requireResponsibility(model, filter.requests);
    const candidates = filter.in_view === undefined
      ? relationshipCandidates(model) : viewCandidates(model, projectedView(model, filter.in_view).view);
    return candidates.filter((candidate) => Object.keys(filter).every((key) => RELATIONSHIP_TESTS[key](model, candidate, filter[key])))
      .map((candidate) => candidate.label);
  }

  // ---- Evaluation: interfaces, operations, and fields ----------------------------------------

  const hasText = (value) => Boolean(value);
  const presence = (present, mode) => present === (mode === 'present');

  /** The fields an operation's input or output holds: those of its inline map, or of the named type (or list of it). */
  function fieldsOfTypeUse(declared, typeUse) {
    if (typeUse === null) return [];
    if (typeUse.fields) return typeUse.fields;
    const named = typeUse.type.invalid ? undefined : declared.types.get(typeUse.type.name);
    return named ? named.fields : [];
  }

  const canonicalTypeOf = (field) => (field.type && !field.type.invalid ? field.type.canonical : null);

  function valuesAreMeaningful(field) {
    return field.valuesForm === 'map' && field.values.length > 0 && field.values.every((entry) => hasText(entry.meaning));
  }

  const VALUES_TESTS = {
    present: (field) => field.values !== null && field.values.length > 0,
    absent: (field) => field.values === null || field.values.length === 0,
    meaningful: valuesAreMeaningful,
  };

  const FIELD_TESTS = {
    name_any: (field, names) => mentionsAny(field.name, names),
    type: (field, type) => canonicalTypeOf(field) === schema.parseTypeExpression(type).canonical,
    type_any: (field, types) => types.some((type) => FIELD_TESTS.type(field, type)),
    meaning: (field, mode) => presence(hasText(field.meaning), mode),
    unit: (field, mode) => presence(hasText(field.unit), mode),
    format: (field, mode) => presence(hasText(field.format), mode),
    constraints: (field, mode) => presence(field.constraints.length > 0, mode),
    values: (field, mode) => VALUES_TESTS[mode](field),
    unit_any: (field, needles) => mentionsAny(field.unit, needles),
  };

  function fieldMatches(field, filter) {
    return Object.keys(filter).every((key) => FIELD_TESTS[key](field, filter[key]));
  }

  /** J12: an operation realizes a responsibility it lists, or whose every direct refinement it realizes, recursively. */
  function realizesResponsibility(model, listed, id, visiting = []) {
    if (listed.includes(id)) return true;
    if (visiting.includes(id)) return false;
    const refinements = allResponsibilities(model).filter((entry) => entry.refines.includes(id));
    return refinements.length > 0 && refinements.every((entry) => hasText(entry.id)
      && realizesResponsibility(model, listed, entry.id, visiting.concat(id)));
  }

  /** The `{ declared, operation }` pair an operation filter judges. */
  const OPERATION_TESTS = {
    id: ({ operation }, id) => operation.id === id,
    of: ({ model, declared }, ref) => (isText(ref) ? declared.id.toLowerCase() === ref.toLowerCase() : interfaceMatches(model, declared, ref)),
    syntax_any: ({ operation }, needles) => mentionsAny(operation.syntax, needles),
    purpose: ({ operation }, mode) => presence(hasText(operation.purpose), mode),
    side_effects: ({ operation }, mode) => presence(operation.sideEffects.length > 0, mode),
    restrictions: ({ declared, operation }, mode) => presence(operation.restrictions.length + declared.restrictions.length > 0, mode),
    errors_at_least: ({ declared, operation }, least) => operation.errors.length + declared.errors.length >= least,
    examples_at_least: ({ operation }, least) => operation.examples.length >= least,
    realizes: ({ model, operation }, ids) => [].concat(ids).every((id) => realizesResponsibility(model, operation.realizes, id)),
    realizes_any: ({ operation }, ids) => ids.some((id) => operation.realizes.includes(id)),
    realizes_at_least: ({ operation }, least) => operation.realizes.length >= least,
    input_has_field: ({ declared, operation }, filter) => fieldsOfTypeUse(declared, operation.input).some((field) => fieldMatches(field, filter)),
    output_has_field: ({ declared, operation }, filter) => fieldsOfTypeUse(declared, operation.output).some((field) => fieldMatches(field, filter)),
  };

  function operationMatches(model, declared, operation, filter) {
    const subject = { model, declared, operation };
    return Object.keys(filter).every((key) => OPERATION_TESTS[key](subject, filter[key]));
  }

  /** True when a relationship whose source is `ids` or inside one of them uses the interface. */
  function usedByAny(model, declared, ids) {
    return model.relationships.some((relationship) => relationship.uses.some((use) => use.interfaceId === declared.id)
      && lineage(model, model.elements.get(relationship.sourceId)).some((id) => ids.has(id)));
  }

  const INTERFACE_TESTS = {
    id: (model, declared, id) => declared.id.toLowerCase() === id.toLowerCase(),
    of: (model, declared, ref) => idsOfRef(model, ref).has(declared.providerId),
    in: (model, declared, ref) => {
      const ids = idsOfRef(model, ref);
      return lineage(model, model.elements.get(declared.providerId)).some((id) => ids.has(id));
    },
    name_any: (model, declared, names) => mentionsAny(declared.name, names),
    style: (model, declared, style) => sameText(declared.style, style),
    has_operation: (model, declared, filter) => declared.operations.some((operation) => operationMatches(model, declared, operation, filter)),
    used_by: (model, declared, ref) => usedByAny(model, declared, idsOfRef(model, ref)),
  };

  function interfaceMatches(model, declared, filter) {
    return Object.keys(filter).every((key) => INTERFACE_TESTS[key](model, declared, filter[key]));
  }

  function interfacesMatching(model, filter) {
    return [...model.interfaces.values()].filter((declared) => interfaceMatches(model, declared, filter));
  }

  // ---- Evaluation: views ---------------------------------------------------------------------

  function missingSelectorMessage(selector, diagnostic) {
    if (diagnostic.rule === 'view/wrong-scope-type') return diagnostic.message;
    const names = { custom: ['view', selector.viewId], dynamic: ['scenario', selector.scopeId], deployment: ['environment', selector.scopeId] };
    if (names[selector.type]) return `No ${names[selector.type][0]} named ${names[selector.type][1]} yet`;
    return `unknown element ${selector.scopeId}`;
  }

  /**
   * The projected view a selector names; a selector that names nothing in the learner's model is a failure, and so
   * is a saved view whose own selector names nothing (the projection then draws no view, `type: null`).
   */
  function projectedView(model, selectorText) {
    const resolved = projection.resolveView(model, selectorText);
    if (resolved.diagnostic) throw unresolved(missingSelectorMessage(projection.parseSelector(selectorText), resolved.diagnostic));
    const selector = resolved.request.canonical;
    const view = projection.projectView(model, selector);
    if (view.type === null) throw unresolved(`The view ${selector} cannot be drawn. ${view.diagnostics[0].message}`);
    return { selector, view };
  }

  /**
   * The ids a view draws, per notation (spec §5.1, §5.3, §6.3): a C4 view's boxes and the boundary around their
   * parts; a sequence diagram's participants; a class diagram's classes (lifted neighbours included); a deployment
   * diagram's nodes and the elements they host; a component diagram's consumers, scope, and providers. An interface
   * card draws no element. Deployment node ids are not element ids; the caller keeps them apart.
   */
  const DRAWN_IDS = {
    c4: (view) => view.nodes.map((node) => node.id)
      .concat(view.boundaries.filter((boundary) => SHOWN_BOUNDARY_KINDS.includes(boundary.kind)).map((boundary) => boundary.id)),
    'uml-sequence': (view) => view.uml.participants.map((participant) => participant.id),
    'uml-class': (view) => view.uml.classes.map((drawn) => drawn.id),
    'uml-deployment': (view) => view.uml.nodes.flatMap((node) => node.hosted.map((instance) => instance.elementId)),
    'uml-component': (view) => view.uml.components.map((component) => component.id),
    'interface-card': () => [],
  };

  /** What a view draws: `elementIds`, the model's elements, and `nodeIds`, the deployment nodes of a deployment view. */
  function drawnBy(model, view) {
    return {
      elementIds: new Set(DRAWN_IDS[view.notation](view).filter((id) => model.elements.has(id))),
      nodeIds: new Set(view.notation === 'uml-deployment' ? view.uml.nodes.map((node) => node.id) : []),
    };
  }

  /** A `shows`/`hides` id names an element, or a node that the deployment view draws. */
  function requireShownRef(model, drawn, item) {
    if (!(isText(item) && drawn.nodeIds.has(item))) requireElementRef(model, item);
  }

  function describeShown(item) {
    return isText(item) ? item : `an element matching ${JSON.stringify(item)}`;
  }

  function shownItemsIn(model, drawn, item) {
    if (isText(item)) return [item].filter((id) => drawn.elementIds.has(id) || drawn.nodeIds.has(id));
    return elementsMatching(model, item).map((element) => element.id).filter((id) => drawn.elementIds.has(id));
  }

  function evaluateView(model, spec) {
    const { selector, view } = projectedView(model, spec.view);
    const drawn = drawnBy(model, view);
    [].concat(spec.shows || [], spec.hides || []).forEach((item) => requireShownRef(model, drawn, item));
    const shown = new Set([...drawn.elementIds, ...drawn.nodeIds]);
    const missing = (spec.shows || []).find((item) => shownItemsIn(model, drawn, item).length === 0);
    if (missing !== undefined) return failure(`The view ${selector} does not show ${describeShown(missing)}`, [...shown]);
    const present = (spec.hides || []).find((item) => shownItemsIn(model, drawn, item).length > 0);
    if (present !== undefined) return failure(`The view ${selector} shows ${describeShown(present)}, which it should not`, [...shown]);
    if (spec.max_elements !== undefined && view.elementCount > spec.max_elements) {
      return failure(`The view ${selector} shows ${view.elementCount} elements; at most ${spec.max_elements} are allowed`, [...shown]);
    }
    return success(`The view ${selector} is as required`, [...shown]);
  }

  // ---- Evaluation: scenario steps ------------------------------------------------------------

  /** The message steps of a scenario with the fragment kinds enclosing each and its reply classification. */
  function flattenSteps(steps, classified, fragments) {
    return steps.flatMap((step, index) => {
      const known = classified[index];
      if (step.kind === 'message') return [{ from: step.from, to: step.to, fragments, reply: known.status === 'reply' }];
      return step.branches.flatMap((branch, branchIndex) =>
        flattenSteps(branch.steps, known.branches[branchIndex].steps, fragments.concat(step.operator)));
    });
  }

  function stepMatches(model, step, filter) {
    return (filter.from === undefined || idsOfRef(model, filter.from).has(step.from))
      && (filter.to === undefined || idsOfRef(model, filter.to).has(step.to))
      && (filter.in_fragment === undefined || step.fragments.includes(filter.in_fragment))
      && (filter.reply === undefined || step.reply === filter.reply);
  }

  function queryStepsOf(model, filter) {
    const scenario = model.scenarios.get(filter.scenario);
    if (!scenario) throw unresolved(`No scenario named ${filter.scenario} yet`);
    requireEndpointRefs(model, filter);
    const steps = flattenSteps(scenario.steps, projection.classifySteps(model, scenario.id), []);
    return steps.filter((step) => stepMatches(model, step, filter)).map((step) => `${step.from}->${step.to}`);
  }

  // ---- Evaluation: queries -------------------------------------------------------------------

  function queryRequirements(model, filter) {
    return [...model.requirements.values()]
      .filter((entry) => (filter.id === undefined || entry.id === filter.id)
        && (filter.kind === undefined || entry.kind === filter.kind)
        && (filter.text_any === undefined || mentionsAny(entry.text, filter.text_any)))
      .map((entry) => entry.id);
  }

  function queryElements(model, filter) {
    requireElementFilterRefs(model, filter);
    return elementsMatching(model, filter).map((element) => element.id);
  }

  function queryResponsibilities(model, filter) {
    requireResponsibilityFilterRefs(model, filter);
    return allResponsibilities(model).filter((entry) => responsibilityMatches(model, entry, filter)).map(responsibilityLabel);
  }

  function queryInterfaces(model, filter) {
    requireInterfaceFilterRefs(model, filter);
    return interfacesMatching(model, filter).map((declared) => declared.id);
  }

  function queryOperations(model, filter) {
    requireOperationFilterRefs(model, filter);
    return [...model.interfaces.values()].flatMap((declared) => declared.operations
      .filter((operation) => operationMatches(model, declared, operation, filter))
      .map((operation) => `${declared.id}.${operation.id}`));
  }

  const QUERY_RUNNERS = {
    element: queryElements, relationship: queryRelationships, responsibility: queryResponsibilities,
    step: queryStepsOf, requirement: queryRequirements, interface: queryInterfaces, operation: queryOperations,
  };

  /** The labels of everything a query matches, and a description of the query for messages. */
  function runQuery(model, query) {
    const [kind] = Object.keys(query);
    return { matched: QUERY_RUNNERS[kind](model, query[kind]), description: `${kind} ${JSON.stringify(query[kind])}` };
  }

  // ---- Evaluation: assertions ----------------------------------------------------------------

  const success = (message, matched = []) => ({ passed: true, message, matched });
  const failure = (message, matched = []) => ({ passed: false, message, matched });

  function evaluateExists(model, predicate) {
    const { matched, description } = runQuery(model, predicate.exists);
    return matched.length > 0 ? success(`Found ${description}`, matched) : failure(`No ${description} yet`);
  }

  function evaluateAbsent(model, predicate) {
    const { matched, description } = runQuery(model, predicate.absent);
    return matched.length === 0 ? success(`No ${description}`) : failure(`Found ${matched.join(', ')} matching ${description}, but there should be none`, matched);
  }

  function evaluateCount(model, predicate) {
    const { matched, description } = runQuery(model, predicate.count);
    const [comparator] = COMPARATORS.filter((key) => key in predicate);
    const wanted = predicate[comparator];
    const holds = { equals: matched.length === wanted, at_least: matched.length >= wanted, at_most: matched.length <= wanted }[comparator];
    const expectation = { equals: `exactly ${wanted}`, at_least: `at least ${wanted}`, at_most: `at most ${wanted}` }[comparator];
    return holds ? success(`${matched.length} match ${description}`, matched)
      : failure(`${matched.length} match ${description}; expected ${expectation}`, matched);
  }

  function evaluateEvery(model, predicate) {
    requireElementFilterRefs(model, predicate.every);
    requireElementFilterRefs(model, predicate.satisfies);
    const subjects = elementsMatching(model, predicate.every);
    const description = JSON.stringify(predicate.every);
    if (subjects.length === 0) return failure(`No element matches ${description} yet, so there is nothing to check`);
    const unsatisfied = subjects.filter((element) => !elementMatches(model, element, predicate.satisfies));
    if (unsatisfied.length === 0) return success(`Every element matching ${description} satisfies ${JSON.stringify(predicate.satisfies)}`, subjects.map((element) => element.id));
    return failure(`${unsatisfied.map((element) => element.id).join(', ')} does not satisfy ${JSON.stringify(predicate.satisfies)}`,
      subjects.filter((element) => !unsatisfied.includes(element)).map((element) => element.id));
  }

  function evaluateChecks(model, predicate, context) {
    const spec = predicate.checks;
    const config = context.checksConfig || {};
    const named = spec.rules || [];
    const categories = spec.categories || [];
    const disabled = new Set(spec.disable || []);
    const selectsAll = named.length === 0 && categories.length === 0;
    const selected = context.checks(model, config)
      .filter((diagnostic) => (selectsAll || named.includes(diagnostic.rule) || categories.includes(diagnostic.category)) && !disabled.has(diagnostic.rule));
    const problems = [['error', spec.max_errors], ['warning', spec.max_warnings]].filter(([, limit]) => limit !== undefined)
      .map(([severity, limit]) => ({ severity, limit, found: selected.filter((diagnostic) => diagnostic.severity === severity) }))
      .filter(({ limit, found }) => found.length > limit);
    if (problems.length === 0) return success('The checks report no more findings than allowed');
    const listed = problems.flatMap(({ found }) => found).slice(0, MAX_LISTED_FINDINGS)
      .map((diagnostic) => `${diagnostic.rule}${diagnostic.element ? ` on ${diagnostic.element}` : ''}: ${diagnostic.message}`);
    const summary = problems.map(({ severity, limit, found }) => `${found.length} ${severity}${found.length === 1 ? '' : 's'} (at most ${limit} allowed)`).join(', ');
    return failure(`The checks report ${summary}: ${listed.join('; ')}`, problems.flatMap(({ found }) => found.map((diagnostic) => diagnostic.rule)));
  }

  /** A YAML value as comparable text: maps compare without regard to key order, lists in order, scalars by their text. */
  function canonicalData(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalData).join(',')}]`;
    if (isMap(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalData(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }

  /**
   * What `same_as_seed` compares (spec §8): where the element sits and its value as written, children included. The
   * layout lives outside the element, so it is excluded; a reference that another edit left dangling is unchanged here
   * and reported by model/unknown-reference instead.
   */
  function snapshotOf(element) {
    return `${element.parentId}\n${canonicalData(element.authored)}`;
  }

  function sameElementsAsSeed(model, seedModel, filter) {
    requireElementFilterRefs(seedModel, filter);
    const seeded = elementsMatching(seedModel, filter);
    if (seeded.length === 0) return failure(`Nothing in the starting design matches ${JSON.stringify(filter)}`);
    for (const original of seeded) {
      const current = model.elements.get(original.id);
      if (!current) return failure(`${original.id} was removed; it should stay as it was`);
      if (snapshotOf(current) !== snapshotOf(original)) return failure(`${original.id} was changed; it should stay as it was`);
    }
    return success('Unchanged from the starting design', seeded.map((element) => element.id));
  }

  const withoutPaths = (key, value) => (key === 'path' ? undefined : value);

  /** Everything an interface says, without source positions (`part: all`). */
  function wholeInterfaceData(declared) {
    return JSON.stringify(Object.assign({}, declared, { types: [...declared.types.values()] }), withoutPaths);
  }

  function fieldSyntax(field) {
    return { name: field.name, type: field.type && field.type.invalid ? field.type.text : canonicalTypeOf(field), required: field.required,
      values: field.values && field.values.map((entry) => entry.value), constraints: field.constraints };
  }

  function typeUseSyntax(typeUse) {
    if (typeUse === null) return null;
    return typeUse.fields ? { fields: typeUse.fields.map(fieldSyntax) }
      : { type: typeUse.type.invalid ? typeUse.type.text : typeUse.type.canonical };
  }

  /** The syntactic view of an interface (`part: syntax`): what a client must write, not what it means. */
  function syntacticInterfaceData(declared) {
    return JSON.stringify({
      style: declared.style, technology: declared.technology, version: declared.version,
      operations: declared.operations.map((operation) => ({ id: operation.id, syntax: operation.syntax,
        input: typeUseSyntax(operation.input), output: typeUseSyntax(operation.output) })),
      types: [...declared.types.values()].map((type) => ({ name: type.name, fields: type.fields.map(fieldSyntax) })),
    });
  }

  const INTERFACE_PARTS = {
    all: { data: wholeInterfaceData, changed: (id) => `${id} was changed; it should stay as it was` },
    syntax: { data: syntacticInterfaceData, changed: (id) => `The syntax of ${id} was changed; it should stay as it was` },
  };

  function sameInterfacesAsSeed(model, seedModel, spec) {
    requireInterfaceFilterRefs(seedModel, spec.interface);
    const seeded = interfacesMatching(seedModel, spec.interface);
    if (seeded.length === 0) return failure(`Nothing in the starting design matches ${JSON.stringify(spec.interface)}`);
    const part = INTERFACE_PARTS[spec.part || 'all'];
    for (const original of seeded) {
      const current = model.interfaces.get(original.id);
      if (!current) return failure(`${original.id} was removed; it should stay as it was`);
      if (current.providerId !== original.providerId) return failure(`${original.id} moved from ${original.providerId} to ${current.providerId}; it should stay as it was`);
      if (part.data(current) !== part.data(original)) return failure(part.changed(original.id));
    }
    return success('Unchanged from the starting design', seeded.map((declared) => declared.id));
  }

  function evaluateSameAsSeed(model, predicate, context) {
    const { seedModel } = context;
    if (!seedModel) return failure('This step has no starting design to compare with');
    const spec = predicate.same_as_seed;
    return isInterfaceSeed(spec) ? sameInterfacesAsSeed(model, seedModel, spec) : sameElementsAsSeed(model, seedModel, spec);
  }

  const ASSERTION_RUNNERS = {
    exists: evaluateExists, absent: evaluateAbsent, count: evaluateCount, every: evaluateEvery,
    checks: evaluateChecks, view: (model, predicate) => evaluateView(model, predicate.view), same_as_seed: evaluateSameAsSeed,
  };

  /**
   * Grades a learner's model against a predicate: `{ passed: true | false | null, message, matched }`. `passed` is
   * null when the model could not be loaded; author errors and anything missing from the model fail with a message.
   */
  function evaluate(model, predicate, context) {
    const validation = validatePredicate(predicate, { checks: context.checksConfig });
    if (!validation.ok) return failure(validation.errors.map((error) => error.message).join('; '));
    if (model === null) return { passed: null, message: 'The design could not be read yet', matched: [] };
    const [assertion] = ASSERTIONS.filter((key) => key in predicate);
    try {
      return ASSERTION_RUNNERS[assertion](model, predicate, context);
    } catch (error) {
      if (error instanceof Unresolved) return failure(error.message);
      throw error;
    }
  }

  return { validatePredicate, evaluate };
});
