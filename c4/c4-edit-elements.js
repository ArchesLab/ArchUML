(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-schema.js'), require('./c4-yaml.js'), require('./c4-model.js'),
      require('./c4-constraints.js'), require('./c4-edit-splices.js'), require('./c4-edit-results.js'),
      require('./c4-edit-references.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.editElements = factory(parts.schema, parts.yaml, parts.model, parts.constraints, parts.editSplices,
      parts.editResults, parts.editReferences);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, yamlAdapter, modelApi, constraints, splicesModule,
  resultsModule, referencesModule) {
  'use strict';

  // The edit commands of the element tree (spec §4.5, §4.6, §4.7, §4.10): elements, their responsibilities, their
  // relationships and the interfaces those use, and their list fields and design choices. The module returns exactly
  // its commands, keyed by `op`.

  const { createDraft, applyStep, draftEdits, removeAndPrune, removeAllAndPrune, pruneEmptied, isEmptyCollection, listInsertion,
    writeFields, replaceEntry, ordered, withoutNulls, withoutEmptyList, writeRawValue, valueAt, isMap, hasOwn,
    startsWith } = splicesModule;
  const { refusal, unknownElement, finished, elementWithField, unknownFieldProblem, textProblem, optionalTextProblem,
    invalidIndex, isIndex, isText, connectorProblem } = resultsModule;
  const { isAncestor, findInterface, shorthandInterfaceOf, interfaceIdTaken, dependents, moveDependents, referenceSites,
    renameTables, renameEdits, withEmptiedLayoutParts } = referencesModule;

  const CHILD_TYPE = { system: 'container', container: 'component', component: 'code' };
  const PARENT_TYPE = { container: 'system', component: 'container', code: 'component' };
  const ROOT_KEY = { person: 'people', system: 'systems' };
  const KINDS = { container: schema.CONTAINER_KINDS, code: schema.CODE_KINDS };
  const CHILD_KEYS = Object.values(schema.CHILD_KEY);
  const RESPONSIBILITY_KINDS = ['know', 'do', 'decide'];
  // Key orders for new keys inside records (spec §4.5, §4.6, §4.8), as the model reads them.
  const RESPONSIBILITY_KEY_ORDER = RESPONSIBILITY_KINDS.concat(['id', 'refines', 'requirements']);
  const COLLABORATOR_KEY_ORDER = schema.COLLABORATOR_ORDER;
  // What the update commands change; other fields have their own commands (choices, hosts, nested nodes).
  const RESPONSIBILITY_UPDATES = ['kind', 'text', 'refines', 'requirements'];
  const RELATIONSHIP_UPDATES = ['description', 'technology', 'connector', 'responsibility'];
  const LIST_FIELDS = ['owns', 'provides', 'invariants', 'quality', 'stereotypes', 'tags', 'attributes', 'operations', 'extends', 'implements'];
  const INHERITANCE_FIELDS = ['extends', 'implements'];
  const DEFAULT_CONNECTOR = 'call';

  // ---- Elements (spec §4.10) ----------------------------------------------------------------

  function addElement(design, { parentId = null, type, kind = null, name }) {
    const { model } = design;
    const parent = parentId === null ? null : model.elements.get(parentId);
    if (parentId !== null && !parent) return unknownElement(parentId);
    const validParent = parent ? CHILD_TYPE[parent.type] === type : type in ROOT_KEY;
    if (typeof name !== 'string' || name.trim() === '') return refusal('invalid-name', 'A new element needs a name');
    if (!validParent) return refusal('invalid-parent', `A ${type} cannot be added ${parent ? `inside ${parentId}` : 'at the top level'}`);
    if (kind !== null && !(KINDS[type] || []).includes(kind)) return refusal('invalid-kind', `A ${type} has no kind ${JSON.stringify(kind)}`);
    const id = schema.uniqueId(schema.slugify(name, type), new Set(model.elements.keys()));
    const value = kind === null ? { name } : { name, kind };
    const edits = parent
      ? yamlAdapter.setEntry(design.parsed, parent.path.concat(schema.CHILD_KEY[parent.type]), id, value, { order: schema.CANONICAL_ORDER })
      : yamlAdapter.setEntry(design.parsed, [ROOT_KEY[type]], id, value, { order: schema.TOP_LEVEL_KEYS });
    return finished(design.text, edits, { elementId: id });
  }

  function setElementField(design, { elementId, field, value }) {
    const element = design.model.elements.get(elementId);
    if (!element) return unknownElement(elementId);
    if (!schema.FIELDS[element.type].includes(field) || CHILD_KEYS.includes(field)) {
      return refusal('invalid-field', `${JSON.stringify(field)} is not a field this command sets on a ${element.type}`);
    }
    const selection = { elementId };
    if (value !== null) {
      return finished(design.text, yamlAdapter.setEntry(design.parsed, element.path, field, value, { order: schema.CANONICAL_ORDER }), selection);
    }
    if (valueAt(yamlAdapter.toData(design.parsed), element.path.concat(field)) === undefined) return finished(design.text, [], selection);
    return finished(design.text, yamlAdapter.deleteEntry(design.parsed, element.path, field), selection);
  }

  /**
   * Removes the element, its subtree, and every reference to them outside it (spec §4.10), with the layout parts and
   * entries of UML views that this empties (UML-view editing spec §4.2); nothing stays selected.
   */
  function deleteElement(design, { elementId }) {
    const element = design.model.elements.get(elementId);
    if (!element) return unknownElement(elementId);
    const paths = dependents(design, elementId).map((dependent) => dependent.removalPath).concat([element.path]);
    const draft = createDraft(design.text);
    removeAllAndPrune(draft, withEmptiedLayoutParts(yamlAdapter.toData(design.parsed), paths));
    return finished(design.text, draftEdits(draft), null);
  }

  /**
   * Renames the element and rewrites every reference to it, including its generated responsibility ids and the
   * references to its shorthand interface, whose id is the element's id (spec §4.10, §4.11).
   */
  function changeElementId(design, { elementId, newId }) {
    const { model, parsed } = design;
    const element = model.elements.get(elementId);
    if (!element) return unknownElement(elementId);
    if (newId === elementId) return finished(design.text, [], { elementId });
    if (!schema.ID_PATTERN.test(newId)) {
      return refusal('invalid-id', 'Ids start with a letter and use letters, digits, - or _');
    }
    const responsibilityIds = generatedResponsibilityRenames(element, newId);
    const shorthand = shorthandInterfaceOf(model, elementId);
    // The element may take the id of an interface it provides itself (spec §4.11).
    const takenId = model.elements.has(newId) || interfaceIdTaken(model, newId, (declared) => declared.providerId === elementId) ? newId
      : [...responsibilityIds.values()].find((id) => model.responsibilityById.has(id));
    if (takenId) return refusal('id-taken', `The id ${JSON.stringify(takenId)} is already used`);
    const renames = renameTables({
      element: new Map([[elementId, newId]]),
      responsibility: responsibilityIds,
      interface: new Map(shorthand ? [[elementId.toLowerCase(), newId]] : []),
    });
    const edits = yamlAdapter.renameKey(parsed, element.path.slice(0, -1), elementId, newId);
    element.responsibilities
      .filter((responsibility) => responsibilityIds.has(responsibility.id))
      .forEach((responsibility) => edits.push(...yamlAdapter.replaceValue(parsed, responsibility.path.concat('id'),
        responsibilityIds.get(responsibility.id))));
    edits.push(...renameEdits(design, renames));
    return finished(design.text, edits, { elementId: newId });
  }

  /**
   * Moves the element under `newParentId`, carrying its text and comments, and removes the collaborator `responsibility`,
   * `uses`, and operation `realizes` entries that stop resolving once it has moved (spec §4.10).
   */
  function moveElement(design, { elementId, newParentId }) {
    const { model } = design;
    const element = model.elements.get(elementId);
    const newParent = model.elements.get(newParentId);
    if (!element) return unknownElement(elementId);
    if (!newParent) return unknownElement(newParentId);
    if (PARENT_TYPE[element.type] !== newParent.type) {
      return refusal('invalid-parent', `A ${element.type} cannot be moved into a ${newParent.type}`);
    }
    const selection = { elementId };
    if (element.parentId === newParentId) return finished(design.text, [], selection);
    const childKey = schema.CHILD_KEY[newParent.type];
    const oldParent = model.elements.get(element.parentId);
    const draft = createDraft(design.text);
    removeAllAndPrune(draft, moveDependents(design, elementId, newParentId).map((dependent) => dependent.removalPath));
    applyStep(draft, yamlAdapter.moveEntry(draft.parsed, oldParent.path.concat(childKey), elementId,
      newParent.path.concat(childKey), { order: schema.CANONICAL_ORDER }));
    pruneEmptied(draft, element.path);
    return finished(design.text, draftEdits(draft), selection);
  }

  /** Generated responsibility ids of `element` (`<element-id>-<kind>-<n>`, spec §4.10) mapped to their new ids. */
  function generatedResponsibilityRenames(element, newId) {
    const generated = new RegExp(`^${escapeRegExp(element.id)}-(${RESPONSIBILITY_KINDS.join('|')})-([0-9]+)$`);
    const renames = new Map();
    element.responsibilities.forEach(({ id }) => {
      const match = id === null ? null : generated.exec(id);
      if (match) renames.set(id, `${newId}-${match[1]}-${match[2]}`);
    });
    return renames;
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---- Responsibilities (spec §4.5) ----------------------------------------------------------

  /** Appends a responsibility in the map form `- <kind>: <text>`. */
  function addResponsibility(design, { elementId, kind, text }) {
    const element = elementWithField(design, elementId, 'responsibilities');
    if (element.error) return element;
    const problem = responsibilityKindProblem(kind) || textProblem('text', text);
    if (problem) return problem;
    const edits = listInsertion(design.parsed, element.path, 'responsibilities', element.responsibilities.length, { [kind]: text },
      schema.CANONICAL_ORDER);
    return finished(design.text, edits, { elementId, responsibilityIndex: element.responsibilities.length });
  }

  /**
   * Changes the kind, text, `refines`, or `requirements` of a responsibility (null or an empty list removes a link).
   * A map item is edited key by key; a string item is written in the map form.
   */
  function updateResponsibility(design, { op, elementId, index, ...changes }) {
    const responsibility = responsibilityAt(design, elementId, index);
    if (responsibility.error) return responsibility;
    const problem = unknownFieldProblem(changes, RESPONSIBILITY_UPDATES) ||
      ('kind' in changes ? responsibilityKindProblem(changes.kind) : null) ||
      ('text' in changes ? textProblem('text', changes.text) : null) ||
      referenceListProblem('refines', changes.refines) || referenceListProblem('requirements', changes.requirements);
    if (problem) return problem;
    const kind = changes.kind || responsibility.kind;
    if (kind === null) return untypedResponsibility();
    const links = {};
    ['refines', 'requirements'].filter((key) => key in changes).forEach((key) => { links[key] = withoutEmptyList(changes[key]); });
    const { path } = responsibility;
    const isMapItem = isMap(valueAt(yamlAdapter.toData(design.parsed), path));
    if (isMapItem && responsibility.kind === null) return untypedResponsibility();
    const draft = createDraft(design.text);
    if (isMapItem) {
      if (kind !== responsibility.kind) applyStep(draft, yamlAdapter.renameKey(draft.parsed, path, responsibility.kind, kind));
      writeFields(draft, path, Object.assign('text' in changes ? { [kind]: changes.text } : {}, links), RESPONSIBILITY_KEY_ORDER);
    } else {
      const current = { refines: oneOrMany(responsibility.refines), requirements: oneOrMany(responsibility.requirements) };
      const value = Object.assign({ [kind]: 'text' in changes ? changes.text : responsibility.text }, current, links);
      replaceEntry(draft, path, withoutNulls(value));
    }
    return finished(design.text, draftEdits(draft), { elementId, responsibilityIndex: index });
  }

  /** Removes a responsibility and every `refines` link and requested `responsibility` that names its id. */
  function removeResponsibility(design, { elementId, index }) {
    const responsibility = responsibilityAt(design, elementId, index);
    if (responsibility.error) return responsibility;
    const references = responsibility.id === null ? [] : referenceSites(design)
      .filter((site) => site.target === 'responsibility' && site.ids.includes(responsibility.id) && !startsWith(site.removalPath, responsibility.path))
      .map((site) => site.removalPath);
    const draft = createDraft(design.text);
    removeAllAndPrune(draft, references.concat([responsibility.path]));
    return finished(design.text, draftEdits(draft), { elementId });
  }

  function moveResponsibility(design, { elementId, from, to }) {
    const element = elementWithField(design, elementId, 'responsibilities');
    if (element.error) return element;
    const count = element.responsibilities.length;
    if (!isIndex(from, count)) return invalidIndex(from);
    if (!isIndex(to, count)) return invalidIndex(to);
    const edits = yamlAdapter.moveItem(design.parsed, element.path.concat('responsibilities'), from, to);
    return finished(design.text, edits, { elementId, responsibilityIndex: to });
  }

  /**
   * Gives a responsibility an id when it has none, `<element-id>-<kind>-<n>` with the first free n (spec §4.10), so a
   * refinement link or a collaborator can name it. The id is in `selection.responsibilityId`.
   */
  function ensureResponsibilityId(design, { elementId, index }) {
    const responsibility = responsibilityAt(design, elementId, index);
    if (responsibility.error) return responsibility;
    const selection = (id) => ({ elementId, responsibilityIndex: index, responsibilityId: id });
    if (responsibility.id !== null) return finished(design.text, [], selection(responsibility.id));
    if (responsibility.kind === null) return untypedResponsibility();
    const taken = design.model.responsibilityById;
    let n = 1;
    while (taken.has(`${elementId}-${responsibility.kind}-${n}`)) n++;
    const id = `${elementId}-${responsibility.kind}-${n}`;
    const draft = createDraft(design.text);
    const { path } = responsibility;
    if (isMap(valueAt(yamlAdapter.toData(draft.parsed), path))) {
      writeFields(draft, path, { id }, RESPONSIBILITY_KEY_ORDER);
    } else {
      replaceEntry(draft, path, { [responsibility.kind]: responsibility.text, id });
    }
    return finished(design.text, draftEdits(draft), selection(id));
  }

  function responsibilityAt(design, elementId, index) {
    const element = elementWithField(design, elementId, 'responsibilities');
    if (element.error) return element;
    return isIndex(index, element.responsibilities.length) ? element.responsibilities[index] : invalidIndex(index);
  }

  function responsibilityKindProblem(kind) {
    return RESPONSIBILITY_KINDS.includes(kind) ? null : refusal('invalid-kind', `A responsibility is one of ${RESPONSIBILITY_KINDS.join(', ')}`);
  }

  function untypedResponsibility() {
    return refusal('untyped-responsibility', 'Choose whether the responsibility is KNOW, DO, or DECIDE first');
  }

  function referenceListProblem(field, value) {
    if (value === undefined || value === null || isText(value)) return null;
    if (Array.isArray(value) && value.every(isText)) return null;
    return refusal('invalid-value', `${field} is one id or a list of ids`);
  }

  /** A one-or-many field as it is written: one id as a string, several as a list, none as null. */
  function oneOrMany(ids) {
    if (ids.length === 0) return null;
    return ids.length === 1 ? ids[0] : ids;
  }

  // ---- Relationships (spec §4.6) -------------------------------------------------------------

  /**
   * Adds a collaborator: a description string, a map when more than the description is given, and a list when the
   * source already has a relationship with the target.
   */
  function addRelationship(design, { sourceId, targetId, description, technology = null, connector = null }) {
    const { model, parsed } = design;
    const source = model.elements.get(sourceId);
    if (!source) return unknownElement(sourceId);
    if (!model.elements.has(targetId)) return unknownElement(targetId);
    if (sourceId === targetId || isAncestor(model, sourceId, targetId) || isAncestor(model, targetId, sourceId)) {
      return refusal('invalid-relationship', 'Relationships connect two elements that do not contain each other');
    }
    const problem = textProblem('description', description) || optionalTextProblem('technology', technology) || connectorProblem(connector);
    if (problem) return problem;
    const value = collaborationValue(relationshipChanges({ description, technology, connector }));
    const collaboratorsPath = source.path.concat('collaborators');
    const collaborators = valueAt(yamlAdapter.toData(parsed), collaboratorsPath);
    const existing = isMap(collaborators) && hasOwn(collaborators, targetId) ? collaborators[targetId] : undefined;
    let edits;
    if (existing === undefined) edits = yamlAdapter.setEntry(parsed, collaboratorsPath, targetId, value, { order: schema.CANONICAL_ORDER });
    else if (Array.isArray(existing)) edits = yamlAdapter.appendItem(parsed, collaboratorsPath.concat(targetId), value);
    // An empty collaborator value is a relationship without a description, which `{}` keeps inside a list.
    else edits = yamlAdapter.setEntry(parsed, collaboratorsPath, targetId, [existing === null ? {} : existing, value]);
    const count = model.relationships.filter((relationship) => relationship.sourceId === sourceId && relationship.targetId === targetId).length + 1;
    return finished(design.text, edits, { relationshipId: count === 1 ? `${sourceId}->${targetId}` : `${sourceId}->${targetId}#${count}` });
  }

  /**
   * Changes the description, technology, connector, or requested responsibility of a relationship (null removes a
   * field). A description string becomes a map only when another field is set; a map stays a map.
   */
  function updateRelationship(design, { op, relationshipId, ...changes }) {
    const relationship = relationshipOf(design, relationshipId);
    if (relationship.error) return relationship;
    const problem = unknownFieldProblem(changes, RELATIONSHIP_UPDATES) ||
      ('description' in changes ? textProblem('description', changes.description) : null) ||
      optionalTextProblem('technology', changes.technology) || optionalTextProblem('responsibility', changes.responsibility) ||
      connectorProblem(changes.connector);
    if (problem) return problem;
    return rewrittenRelationship(design, relationship, relationshipChanges(changes));
  }

  function removeRelationship(design, { relationshipId }) {
    const relationship = relationshipOf(design, relationshipId);
    if (relationship.error) return relationship;
    const { path } = relationship;
    const holder = path.slice(0, -1);
    // The last relationship of a list goes with its target key, which an empty list would leave behind.
    const onlyItem = typeof path[path.length - 1] === 'number' && valueAt(yamlAdapter.toData(design.parsed), holder).length === 1;
    const draft = createDraft(design.text);
    removeAndPrune(draft, onlyItem ? holder : path);
    return finished(design.text, draftEdits(draft), null);
  }

  /** Writes `changes` (validated; null removes a field) into the collaborator value of `relationship`. */
  function rewrittenRelationship(design, relationship, changes) {
    const draft = createDraft(design.text);
    const { path } = relationship;
    const current = valueAt(yamlAdapter.toData(draft.parsed), path);
    if (isMap(current)) {
      writeFields(draft, path, changes, COLLABORATOR_KEY_ORDER);
    } else {
      const value = collaborationValue(Object.assign({ description: current }, changes));
      if (typeof value === 'string' && typeof current === 'string') {
        if (value !== current) applyStep(draft, yamlAdapter.replaceValue(draft.parsed, path, value));
      } else if (!(current === null && isEmptyCollection(value))) {
        replaceEntry(draft, path, value);
      }
    }
    return finished(design.text, draftEdits(draft), { relationshipId: relationship.id });
  }

  function relationshipOf(design, relationshipId) {
    const relationship = design.model.relationships.find((candidate) => candidate.id === relationshipId);
    return relationship || refusal('unknown-relationship', `There is no relationship ${JSON.stringify(relationshipId)}`);
  }

  /** Changes as they are written: empty text and the default connector `call` leave the field out. */
  function relationshipChanges(changes) {
    const written = {};
    Object.entries(changes).forEach(([key, value]) => {
      written[key] = value === '' || (key === 'connector' && value === DEFAULT_CONNECTOR) ? null : value;
    });
    return written;
  }

  /** A collaborator value: the description alone as a string, otherwise a map of the fields that are set. */
  function collaborationValue(fields) {
    const value = withoutNulls(ordered(fields, COLLABORATOR_KEY_ORDER));
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === 'description' ? value.description : value;
  }

  /**
   * Sets the interfaces a relationship uses (spec §4.6): one entry as a text, several as a flow list, none removes the
   * key. A description string becomes a map. Entries that name no interface, or one J7 does not allow, are refused.
   */
  function setUses(design, { relationshipId, uses }) {
    const relationship = relationshipOf(design, relationshipId);
    if (relationship.error) return relationship;
    if (!Array.isArray(uses) || !uses.every(isText)) return refusal('invalid-value', 'uses is a list of <interface> or <interface>.<operation> entries');
    const problem = uses.map((text) => useProblem(design.model, relationship, text)).find(Boolean);
    if (problem) return problem;
    const { path } = relationship;
    const draft = createDraft(design.text);
    const current = valueAt(yamlAdapter.toData(draft.parsed), path);
    if (!isMap(current) && uses.length > 0) replaceEntry(draft, path, collaborationValue({ description: current, uses: uses[0] }));
    if (uses.length > 1) writeRawValue(draft, path, 'uses', yamlAdapter.stringifyFragment(uses, { flow: true }), COLLABORATOR_KEY_ORDER);
    else if (isMap(current) || uses.length > 0) writeFields(draft, path, { uses: uses.length === 1 ? uses[0] : null }, COLLABORATOR_KEY_ORDER);
    return finished(design.text, draftEdits(draft), { relationshipId: relationship.id });
  }

  function useProblem(model, relationship, text) {
    const ref = schema.parseUsesRef(text);
    if (ref.error) return refusal('invalid-value', `${text} does not name an interface; write <interface-id> or <interface-id>.<operation-id>`);
    const declared = findInterface(model, ref.interfaceId);
    if (!declared) {
      const suggestion = schema.suggest(ref.interfaceId, [...model.interfaces.keys()]);
      return refusal('unknown-interface', `There is no interface ${ref.interfaceId}${suggestion ? `; did you mean ${suggestion}?` : ''}`);
    }
    if (ref.operationId !== null && !declared.operations.some((operation) => operation.id === ref.operationId)) {
      return refusal('unknown-interface', `The interface ${declared.id} has no operation ${ref.operationId}`);
    }
    if (modelApi.useKind(model, relationship.sourceId, relationship.targetId, declared.id) !== null) return null;
    return refusal('interface-provider', `${relationship.sourceId} cannot use ${declared.id} when it collaborates with ` +
      `${relationship.targetId}; use an interface of ${relationship.targetId}, of a part of it, or of an element that contains it`);
  }

  // ---- Lists and choices ---------------------------------------------------------------------

  /**
   * Writes a list field of an element (`owns`, `invariants`, `tags`, …); an empty list removes the field. A `provides`
   * written in the full form is edited with the interface commands instead (spec §9.5). An entry added to `extends` or
   * `implements` must keep the kind rule (UML-view editing spec §4.3); entries already in the YAML are not checked.
   */
  function setList(design, { elementId, field, items }) {
    if (!LIST_FIELDS.includes(field)) return refusal('invalid-field', `${JSON.stringify(field)} is not a list this command sets`);
    const element = elementWithField(design, elementId, field);
    if (element.error) return element;
    if (field === 'provides' && isMap(valueAt(yamlAdapter.toData(design.parsed), element.path.concat('provides')))) {
      return refusal('provides-full-form', `${elementId} describes its interfaces in full; edit them in the Interfaces section`);
    }
    if (!Array.isArray(items) || !items.every(isText)) return refusal('invalid-value', `${field} is a list of texts`);
    const problem = INHERITANCE_FIELDS.includes(field) ? addedInheritanceProblem(design.model, element, field, items) : null;
    if (problem) return problem;
    return setElementField(design, { elementId, field, value: items.length > 0 ? items : null });
  }

  /** The refusal of the first entry `items` adds to the element's `extends` or `implements` (`relation`) that the kind rule forbids. */
  function addedInheritanceProblem(model, element, relation, items) {
    const added = items.filter((targetId) => !element.code[relation].includes(targetId));
    for (const targetId of added) {
      const code = constraints.inheritanceProblem(model, element.id, relation, targetId);
      if (code) return refusal(code, inheritanceMessage(model, element, relation, targetId, code));
    }
    return null;
  }

  // What an element is, with its article, for the refusals of `addedInheritanceProblem`.
  const TYPE_WORDS = { person: 'a person', system: 'a software system', container: 'a container', component: 'a component' };
  const CODE_KIND_WORDS = { class: 'a class', abstract_class: 'an abstract class', interface: 'an interface', enum: 'an enum',
    function: 'a function', module: 'a module' };
  const KIND_RULES = {
    extends: 'a class extends a class, and an interface extends an interface',
    implements: 'a class, an abstract class, or an enum implements an interface',
  };

  function inheritanceMessage(model, source, relation, targetId, code) {
    const target = model.elements.get(targetId);
    if (code === 'extends-target') {
      const what = target ? TYPE_WORDS[target.type] : 'not an element of the model';
      return `${source.id} can ${relation === 'extends' ? 'extend' : 'implement'} only a code element, and ${targetId} is ${what}`;
    }
    if (code === 'implements-target') return `Only an interface can be implemented, and ${targetId} is ${CODE_KIND_WORDS[target.kind]}`;
    if (code === 'extends-cycle') return `${targetId} already extends ${source.id}, so ${source.id} cannot extend ${targetId}`;
    return `${source.id} is ${CODE_KIND_WORDS[source.kind]} and ${targetId} is ${CODE_KIND_WORDS[target.kind]}; ${KIND_RULES[relation]}`;
  }

  /** Writes the design choices (spec §4.7) of an element or of a relationship; null or `{}` removes them. */
  function setChoices(design, { elementId, relationshipId, choices }) {
    if (choices !== null && !isMap(choices)) return refusal('invalid-value', 'choices is a map of technology, styles, patterns, and tactics');
    const value = choices === null || Object.keys(choices).length === 0 ? null : choices;
    if (relationshipId !== undefined) {
      const relationship = relationshipOf(design, relationshipId);
      return relationship.error ? relationship : rewrittenRelationship(design, relationship, { choices: value });
    }
    const element = elementWithField(design, elementId, 'choices');
    if (element.error) return element;
    return setElementField(design, { elementId, field: 'choices', value });
  }

  return {
    addElement, setElementField, deleteElement, changeElementId, moveElement, addResponsibility,
    updateResponsibility, removeResponsibility, moveResponsibility, ensureResponsibilityId, addRelationship,
    updateRelationship, removeRelationship, setUses, setList, setChoices,
  };
});
