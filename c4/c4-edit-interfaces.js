(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-schema.js'), require('./c4-yaml.js'), require('./c4-edit-splices.js'),
      require('./c4-edit-results.js'), require('./c4-edit-references.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.editInterfaces = factory(parts.schema, parts.yaml, parts.editSplices, parts.editResults, parts.editReferences);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, yamlAdapter, splicesModule, resultsModule, referencesModule) {
  'use strict';

  // The edit commands of interface descriptions (spec §4.11, §9.5): interfaces, their operations, errors, examples,
  // types and fields, and vocabulary terms. The module returns exactly its commands, keyed by `op`.
  //
  // An interface is named by its id, compared ignoring case. A shorthand interface (a `provides` list of syntax lines)
  // only gains, changes, reorders, and loses syntax lines; every other edit needs the full form, which
  // expandProvidesShorthand writes. Fields, errors, values, terms, and examples are each one map entry or list item.

  const { PLACEHOLDER, createDraft, applyStep, draftEdits, removeAndPrune, removeAllAndPrune, isEmptyCollection, listInsertion,
    writeFields, replaceEntry, ordered, withoutNulls, withoutEmptyList, writeRawValue, writeBlockEntry, isFlowCollectionAt, valueAt,
    isMap, hasOwn, fieldOf } = splicesModule;
  const { refusal, unknownElement, finished, unknownFieldProblem, textProblem, optionalTextProblem, invalidIndex, isIndex,
    isText } = resultsModule;
  const { findInterface, shorthandInterfaceOf, interfaceIdTaken, usesSites, renameTables, renameEdits } = referencesModule;

  const PROVIDER_TYPES = ['system', 'container', 'component'];
  const INTERFACE_UPDATES = ['name', 'description', 'style', 'technology', 'version'];
  const OPERATION_UPDATES = ['syntax', 'input', 'output', 'purpose', 'side_effects', 'realizes'];
  const OPERATION_LIST_UPDATES = ['side_effects', 'realizes'];
  const PAYLOAD_PARTS = ['input', 'output'];
  /** Field keys of the syntactic view; a field with only these (and values without meanings) is a flow map. */
  const SYNTAX_FIELD_KEYS = ['type', 'required', 'values', 'constraints'];
  const EXAMPLE_TEXT_KEYS = { input: 'inputText', output: 'outputText' };
  // A protocol code of digits (`401`), written unquoted as it reads the same under the failsafe schema.
  const NUMERIC_CODE = /^[1-9][0-9]{0,8}$/;

  /** Rewrites a shorthand `provides` list in the full form, keeping its derived operation ids (spec §4.11). */
  function expandProvidesShorthand(design, { elementId }) {
    const element = design.model.elements.get(elementId);
    if (!element) return unknownElement(elementId);
    const shorthand = shorthandInterfaceOf(design.model, elementId);
    if (!shorthand) return refusal('not-shorthand', `${elementId} has no shorthand provides list`);
    const draft = createDraft(design.text);
    writeExpanded(draft, element, shorthand);
    return finished(design.text, draftEdits(draft), { elementId, interfaceId: elementId });
  }

  function writeExpanded(draft, element, shorthand) {
    const operations = Object.fromEntries(shorthand.operations.map((operation) => [operation.id, operation.syntax]));
    writeBlockEntry(draft, element.path, 'provides', { [shorthand.id]: { name: shorthand.name, operations } }, schema.CANONICAL_ORDER);
  }

  /**
   * Adds an interface with a slug id unique among element and interface ids, ignoring case. A shorthand list is
   * written in the full form first, and the two changes are returned as one splice, so they are one undo step.
   */
  function addInterface(design, { elementId, name, id = null, style = null, technology = null }) {
    const { model } = design;
    const element = model.elements.get(elementId);
    if (!element) return unknownElement(elementId);
    if (!PROVIDER_TYPES.includes(element.type)) return refusal('invalid-field', `A ${element.type} provides no interfaces`);
    const problem = textProblem('name', name) || styleProblem(style) || optionalTextProblem('technology', technology) ||
      (id === null ? null : newInterfaceIdProblem(model, id, elementId, null));
    if (problem) return problem;
    const interfaceId = id !== null ? id : schema.uniqueId(schema.slugify(name, 'interface'), takenInterfaceIds(model));
    const value = withoutNulls({ name, style, technology });
    const providesPath = element.path.concat('provides');
    const shorthand = shorthandInterfaceOf(model, elementId);
    const current = valueAt(yamlAdapter.toData(design.parsed), providesPath);
    if (!shorthand && Array.isArray(current) && current.length > 0) {
      return refusal('invalid-value', `The provides list of ${elementId} is not a list of syntax lines; fix it in the text first`);
    }
    const draft = createDraft(design.text);
    if (shorthand) writeExpanded(draft, element, shorthand);
    if (isMap(valueAt(yamlAdapter.toData(draft.parsed), providesPath))) {
      applyStep(draft, yamlAdapter.setEntry(draft.parsed, providesPath, interfaceId, value));
    } else {
      writeBlockEntry(draft, element.path, 'provides', { [interfaceId]: value }, schema.CANONICAL_ORDER);
    }
    const edits = shorthand ? [yamlAdapter.differingSpan(design.text, draft.text)] : draftEdits(draft);
    return finished(design.text, edits, { elementId, interfaceId });
  }

  /** Sets the name, description, style, technology, or version of an interface; null removes it. */
  function updateInterface(design, { interfaceId, field, value }) {
    const declared = describedInterface(design, interfaceId);
    if (declared.error) return declared;
    if (!INTERFACE_UPDATES.includes(field)) return refusal('invalid-field', `${JSON.stringify(field)} is not a field this command sets on an interface`);
    const problem = value === null ? null : field === 'style' ? styleProblem(value) : textProblem(field, value);
    if (problem) return problem;
    const draft = createDraft(design.text);
    writeFields(draft, declared.path, { [field]: value }, schema.INTERFACE_ORDER);
    return finished(design.text, draftEdits(draft), { interfaceId: declared.id });
  }

  /** Removes an interface and every `uses` entry that names it (spec §4.10). */
  function removeInterface(design, { interfaceId }) {
    const declared = interfaceRecord(design, interfaceId);
    if (declared.error) return declared;
    const uses = usesSites(design, declared.id, null).map((site) => site.removalPath);
    const draft = createDraft(design.text);
    removeAllAndPrune(draft, uses.concat([declared.path]));
    return finished(design.text, draftEdits(draft), { elementId: declared.providerId });
  }

  /** Renames an interface and rewrites the `uses` entries and `interface <id>` selectors that name it (spec §4.10). */
  function changeInterfaceId(design, { interfaceId, newId }) {
    const declared = interfaceRecord(design, interfaceId);
    if (declared.error) return declared;
    if (declared.shorthand) {
      return refusal('shorthand', `${declared.id} is the shorthand interface of ${declared.providerId} and has its id; describe it fully first`);
    }
    if (newId === declared.id) return finished(design.text, [], { interfaceId: newId });
    const problem = newInterfaceIdProblem(design.model, newId, declared.providerId, declared);
    if (problem) return problem;
    const edits = yamlAdapter.renameKey(design.parsed, declared.path.slice(0, -1), declared.id, newId)
      .concat(renameEdits(design, renameTables({ interface: new Map([[declared.id.toLowerCase(), newId]]) })));
    return finished(design.text, edits, { interfaceId: newId });
  }

  /** Writes the restrictions of an interface, or of one of its operations; an empty list removes them. */
  function setRestrictions(design, { interfaceId, operationId = null, items }) {
    const holder = semanticHolder(design, interfaceId, operationId);
    if (holder.error) return holder;
    if (!Array.isArray(items) || !items.every(isText)) return refusal('invalid-value', 'restrictions is a list of texts');
    const draft = createDraft(design.text);
    writeHolderFields(draft, holder, { restrictions: withoutEmptyList(items) });
    return finished(design.text, draftEdits(draft), holder.selection);
  }

  /** Adds an operation as its syntax line; its id is derived from the syntax (spec §4.11) unless given. */
  function addOperation(design, { interfaceId, syntax, id = null }) {
    const declared = interfaceRecord(design, interfaceId);
    if (declared.error) return declared;
    const problem = lineProblem('syntax', syntax);
    if (problem) return problem;
    const taken = new Set(declared.operations.map((operation) => operation.id));
    if (id !== null && (declared.shorthand || !schema.ID_PATTERN.test(id))) {
      return declared.shorthand ? shorthandRefusal(declared) : idFormatRefusal();
    }
    if (id !== null && taken.has(id)) return idTaken(id);
    const operationId = id !== null ? id : schema.deriveOperationId(syntax, taken);
    const edits = declared.shorthand
      ? yamlAdapter.appendItem(design.parsed, declared.path, syntax)
      : yamlAdapter.setEntry(design.parsed, declared.path.concat('operations'), operationId, syntax, { order: schema.INTERFACE_ORDER });
    return finished(design.text, edits, { interfaceId: declared.id, operationId });
  }

  /**
   * Sets the syntax, input, output, purpose, side effects, or realized responsibilities of an operation (null or an
   * empty list removes one). An operation written as its syntax line becomes a map only when another field is set.
   */
  function updateOperation(design, { interfaceId, operationId, field, value }) {
    const target = operationTarget(design, interfaceId, operationId);
    if (target.error) return target;
    const { declared, operation } = target;
    if (!OPERATION_UPDATES.includes(field)) return refusal('invalid-field', `${JSON.stringify(field)} is not a field this command sets on an operation`);
    const problem = operationValueProblem(field, value);
    if (problem) return problem;
    const selection = { interfaceId: declared.id, operationId: operation.id };
    if (declared.shorthand && field !== 'syntax') return shorthandRefusal(declared);
    const written = OPERATION_LIST_UPDATES.includes(field) ? withoutEmptyList(value)
      : PAYLOAD_PARTS.includes(field) && value !== null ? standardTypeText(value) : value;
    const draft = createDraft(design.text);
    const current = valueAt(yamlAdapter.toData(draft.parsed), operation.path);
    if (typeof current === 'string' && field === 'syntax') {
      if (written !== current) applyStep(draft, yamlAdapter.replaceValue(draft.parsed, operation.path, written));
    } else {
      writeHolderFields(draft, { path: operation.path, operation, order: schema.OPERATION_ORDER }, { [field]: written });
    }
    return finished(design.text, draftEdits(draft), selection);
  }

  /** Renames an operation and rewrites the `uses` entries that name it (spec §4.10). */
  function renameOperation(design, { interfaceId, operationId, newId }) {
    const target = operationTarget(design, interfaceId, operationId);
    if (target.error) return target;
    const { declared, operation } = target;
    if (declared.shorthand) return shorthandRefusal(declared);
    if (newId === operation.id) return finished(design.text, [], { interfaceId: declared.id, operationId: newId });
    if (typeof newId !== 'string' || !schema.ID_PATTERN.test(newId)) return idFormatRefusal();
    if (declared.operations.some((other) => other.id === newId)) return idTaken(newId);
    const renames = renameTables({ operation: new Map([[`${declared.id.toLowerCase()}.${operation.id}`, newId]]) });
    const edits = yamlAdapter.renameKey(design.parsed, operation.path.slice(0, -1), operation.id, newId)
      .concat(renameEdits(design, renames));
    return finished(design.text, edits, { interfaceId: declared.id, operationId: newId });
  }

  /** Removes an operation and the `uses` entries that name it; whole-interface uses stay (spec §4.10). */
  function removeOperation(design, { interfaceId, operationId }) {
    const target = operationTarget(design, interfaceId, operationId);
    if (target.error) return target;
    const { declared, operation } = target;
    const uses = usesSites(design, declared.id, operation.id).map((site) => site.removalPath);
    const draft = createDraft(design.text);
    removeAllAndPrune(draft, uses.concat([operation.path]));
    return finished(design.text, draftEdits(draft), { interfaceId: declared.id });
  }

  /** Moves the operation at `from` to index `to`, with its text and comments. */
  function moveOperation(design, { interfaceId, from, to }) {
    const declared = interfaceRecord(design, interfaceId);
    if (declared.error) return declared;
    const ids = declared.operations.map((operation) => operation.id);
    if (!isIndex(from, ids.length)) return invalidIndex(from);
    if (!isIndex(to, ids.length)) return invalidIndex(to);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    const selection = { interfaceId: declared.id, operationId: moved };
    if (from === to) return finished(design.text, [], selection);
    const edits = declared.shorthand
      ? yamlAdapter.moveItem(design.parsed, declared.path, from, to)
      : yamlAdapter.moveEntry(design.parsed, declared.path.concat('operations'), moved, declared.path.concat('operations'), { order: ids });
    return finished(design.text, edits, selection);
  }

  /**
   * Sets one error of an interface, or of one of its operations: `value` is the text saying when it happens and what
   * the client does, `{ when, code }`, or null to remove it.
   */
  function setError(design, { interfaceId, operationId = null, name, value }) {
    const holder = semanticHolder(design, interfaceId, operationId);
    if (holder.error) return holder;
    if (typeof name !== 'string' || !schema.ID_PATTERN.test(name)) return refusal('id-format', 'Error names start with a letter and use letters, digits, - or _');
    const written = errorValue(value);
    if (written && written.error) return written;
    const draft = createDraft(design.text);
    const errorPath = holder.path.concat('errors', name);
    if (written === null) {
      if (valueAt(yamlAdapter.toData(draft.parsed), errorPath) !== undefined) removeAllAndPrune(draft, [errorPath]);
    } else {
      if (holder.operation) ensureOperationMap(draft, holder.operation);
      applyStep(draft, yamlAdapter.setEntry(draft.parsed, holder.path.concat('errors'), name, written, { order: holder.order }));
    }
    return finished(design.text, draftEdits(draft), holder.selection);
  }

  /** An error as it is written: its text, or `{ when, code }` in canonical order with a numeric code unquoted. */
  function errorValue(value) {
    if (value === null || isText(value)) return value;
    const shape = refusal('invalid-value', 'An error is the text saying when it happens, or a map of when and code');
    if (!isMap(value) || unknownFieldProblem(value, schema.ERROR_KEYS)) return shape;
    const fields = withoutNulls(value);
    if (Object.keys(fields).length === 0 || !Object.values(fields).every(isText)) return shape;
    if (fields.code !== undefined && NUMERIC_CODE.test(fields.code)) fields.code = Number(fields.code);
    return ordered(fields, schema.ERROR_KEYS);
  }

  // ---- Interfaces: examples ----

  /** Adds an example whose input and output are the texts the user typed, each one YAML flow node (spec §4.11). */
  function addExample(design, { interfaceId, operationId, inputText = null, outputText = null, note = null }) {
    const target = operationTarget(design, interfaceId, operationId, { described: true });
    if (target.error) return target;
    const texts = { input: inputText, output: outputText };
    if (inputText === null && outputText === null && note === null) {
      return refusal('invalid-value', 'An example needs at least one of input, output, and note');
    }
    const problem = exampleTextsProblem(texts) || optionalTextProblem('note', note);
    if (problem) return problem;
    const { operation } = target;
    const draft = createDraft(design.text);
    ensureOperationMap(draft, operation);
    const index = operation.examples.length;
    const placeholders = withoutNulls({ input: inputText === null ? null : PLACEHOLDER, output: outputText === null ? null : PLACEHOLDER, note });
    applyStep(draft, listInsertion(draft.parsed, operation.path, 'examples', index, placeholders, schema.OPERATION_ORDER));
    writeExampleTexts(draft, operation.path.concat('examples', index), withoutNulls(texts));
    return finished(design.text, draftEdits(draft), target.selection);
  }

  /** Changes the input text, output text, or note of an example; null removes one, as long as one remains. */
  function updateExample(design, { op, interfaceId, operationId, index, ...changes }) {
    const target = operationTarget(design, interfaceId, operationId, { described: true });
    if (target.error) return target;
    const { operation } = target;
    if (!isIndex(index, operation.examples.length)) return invalidIndex(index);
    const problem = unknownFieldProblem(changes, ['inputText', 'outputText', 'note']) ||
      exampleTextsProblem({ input: changes.inputText, output: changes.outputText }) || optionalTextProblem('note', changes.note);
    if (problem) return problem;
    const path = operation.path.concat('examples', index);
    const draft = createDraft(design.text);
    const current = valueAt(yamlAdapter.toData(draft.parsed), path);
    const written = { input: changes.inputText, output: changes.outputText, note: changes.note };
    const remaining = schema.EXAMPLE_KEYS.filter((key) => (written[key] === undefined ? fieldOf(current, key) != null : written[key] !== null));
    if (remaining.length === 0) return refusal('invalid-value', 'An example needs at least one of input, output, and note');
    const texts = {};
    Object.entries(EXAMPLE_TEXT_KEYS).forEach(([key, name]) => {
      if (changes[name] === null) writeFields(draft, path, { [key]: null }, schema.EXAMPLE_KEYS);
      else if (changes[name] !== undefined) texts[key] = changes[name];
    });
    writeExampleTexts(draft, path, texts);
    if (changes.note !== undefined) writeFields(draft, path, { note: changes.note }, schema.EXAMPLE_KEYS);
    return finished(design.text, draftEdits(draft), target.selection);
  }

  function removeExample(design, { interfaceId, operationId, index }) {
    const target = operationTarget(design, interfaceId, operationId, { described: true });
    if (target.error) return target;
    if (!isIndex(index, target.operation.examples.length)) return invalidIndex(index);
    const draft = createDraft(design.text);
    removeAndPrune(draft, target.operation.path.concat('examples', index));
    return finished(design.text, draftEdits(draft), target.selection);
  }

  /** Writes each of `texts` (`{ input, output }`), as typed, over the value of that key of the example at `path`. */
  function writeExampleTexts(draft, path, texts) {
    Object.entries(texts).forEach(([key, text]) => writeRawValue(draft, path, key, text.trim(), schema.EXAMPLE_KEYS));
  }

  function exampleTextsProblem(texts) {
    return Object.entries(EXAMPLE_TEXT_KEYS)
      .map(([key, name]) => (texts[key] === undefined || texts[key] === null ? null : exampleSyntaxProblem(name, texts[key])))
      .find(Boolean) || null;
  }

  /**
   * Null when `text` is one YAML flow node that reads the same as a block map value and as a flow list item; else
   * `{ error: 'example-syntax', message, line }` with the parser's message and line.
   */
  function exampleSyntaxProblem(name, text) {
    const syntax = (message, line = 1) => ({ error: 'example-syntax', message, line });
    if (typeof text !== 'string' || text.trim() === '') return syntax(`${name} needs some text`);
    if (/[\r\n]/.test(text)) return syntax(`${name} is one line of YAML flow text, such as {id: 7, status: open}`);
    const alone = yamlAdapter.parse(text);
    if (alone.errors.length > 0) return syntax(alone.errors[0].message, alone.errors[0].range.start.line);
    const asValue = yamlAdapter.parse(`x: ${text.trim()}\n`);
    const asItem = yamlAdapter.parse(`[${text.trim()}]\n`);
    const readsAsOneNode = asValue.errors.length === 0 && asItem.errors.length === 0 &&
      Object.keys(yamlAdapter.toData(asValue) || {}).length === 1 && yamlAdapter.toData(asItem).length === 1;
    return readsAsOneNode ? null : syntax(`${name} is one YAML flow node, such as {id: 7, status: open}, [a, b], or a single value`);
  }

  // ---- Interfaces: types and fields ----

  /** Creates or changes a type's description; null removes the type unless the interface still refers to it. */
  function setType(design, { interfaceId, typeName, value }) {
    const declared = describedInterface(design, interfaceId);
    if (declared.error) return declared;
    const problem = typeNameProblem(typeName);
    if (problem) return problem;
    const path = declared.path.concat('types', typeName);
    const selection = { interfaceId: declared.id, typeName };
    const draft = createDraft(design.text);
    if (value === null) {
      if (!declared.types.has(typeName)) return finished(design.text, [], selection);
      const uses = typeUses(declared, typeName);
      if (uses.length > 0) return { error: 'type-in-use', message: `${typeName} is still used by ${uses.join(', ')}`, uses };
      removeAndPrune(draft, path);
    } else {
      const valueProblem = !isMap(value) ? refusal('invalid-value', 'A type is a map with a description')
        : unknownFieldProblem(value, ['description']) || optionalTextProblem('description', value.description);
      if (valueProblem) return valueProblem;
      if (declared.types.has(typeName)) writeFields(draft, path, value, schema.TYPE_ORDER);
      else applyStep(draft, yamlAdapter.setEntry(draft.parsed, declared.path.concat('types'), typeName, withoutNulls(value), { order: schema.INTERFACE_ORDER }));
    }
    return finished(design.text, draftEdits(draft), selection);
  }

  /** Renames a type and the `input`, `output`, and field types of the same interface that name it (`T`, `T[]`). */
  function renameType(design, { interfaceId, typeName, newName }) {
    const declared = describedInterface(design, interfaceId);
    if (declared.error) return declared;
    if (!declared.types.has(typeName)) return unknownType(typeName);
    const selection = { interfaceId: declared.id, typeName: newName };
    if (newName === typeName) return finished(design.text, [], selection);
    const problem = typeNameProblem(newName) || (declared.types.has(newName) ? nameTaken(newName) : null);
    if (problem) return problem;
    const data = yamlAdapter.toData(design.parsed);
    const edits = yamlAdapter.renameKey(design.parsed, declared.path.concat('types'), typeName, newName);
    typeReferences(declared, data).filter((reference) => reference.type.name === typeName).forEach((reference) => {
      edits.push(...yamlAdapter.replaceValue(design.parsed, reference.path, reference.type.list ? `${newName}[]` : newName));
    });
    return finished(design.text, edits, selection);
  }

  /**
   * Where the interface names a type: `{ label, path, type, ownerType }` for each input, output, and field type
   * expression; `ownerType` is the type whose field it is, else null.
   */
  function typeReferences(declared, data) {
    const references = [];
    const addFields = (fields, labelOf, ownerType) => fields.filter((field) => field.type && !field.type.invalid).forEach((field) => {
      const path = typeof valueAt(data, field.path) === 'string' ? field.path : field.path.concat('type');
      references.push({ label: labelOf(field), path, type: field.type, ownerType });
    });
    declared.operations.forEach((operation) => PAYLOAD_PARTS.forEach((part) => {
      const use = operation[part];
      if (use && use.fields) addFields(use.fields, (field) => `${operation.id} ${part}.${field.name}`, null);
      else if (use && !use.type.invalid) {
        references.push({ label: `${operation.id} ${part}`, path: operation.path.concat(part), type: use.type, ownerType: null });
      }
    }));
    declared.types.forEach((type) => addFields(type.fields, (field) => `${type.name}.${field.name}`, type.name));
    return references;
  }

  /** What still refers to `typeName`, apart from the type's own fields. */
  function typeUses(declared, typeName) {
    return typeReferences(declared, null).filter((reference) => reference.type.name === typeName && reference.ownerType !== typeName)
      .map((reference) => reference.label);
  }

  /**
   * Sets a field of a type (`owner: { typeName }`) or of an inline input or output (`owner: { operationId, part }`);
   * null removes it. A field with only a type is written as the type; with only syntactic keys as a flow map; with a
   * meaning, unit, format, example, or value meanings as a block map (spec §4.11). Types are written in standard form.
   */
  function setField(design, { interfaceId, owner, fieldName, field }) {
    const holder = fieldHolder(design, interfaceId, owner);
    if (holder.error) return holder;
    const problem = fieldNameProblem(fieldName);
    if (problem) return problem;
    const selection = Object.assign({}, holder.selection, { fieldName });
    const path = holder.path.concat(fieldName);
    const draft = createDraft(design.text);
    if (field === null) {
      if (valueAt(yamlAdapter.toData(draft.parsed), path) !== undefined) removeAndPrune(draft, path);
      return finished(design.text, draftEdits(draft), selection);
    }
    const value = fieldValue(field);
    if (value.error) return value;
    if (holder.operation) ensureOperationMap(draft, holder.operation);
    writeField(draft, holder, fieldName, value);
    return finished(design.text, draftEdits(draft), selection);
  }

  function renameField(design, { interfaceId, owner, fieldName, newName }) {
    const holder = fieldHolder(design, interfaceId, owner);
    if (holder.error) return holder;
    const fields = valueAt(yamlAdapter.toData(design.parsed), holder.path);
    if (!isMap(fields) || !hasOwn(fields, fieldName)) return unknownField(fieldName);
    const selection = Object.assign({}, holder.selection, { fieldName: newName });
    if (newName === fieldName) return finished(design.text, [], selection);
    const problem = fieldNameProblem(newName) || (hasOwn(fields, newName) ? nameTaken(newName) : null);
    if (problem) return problem;
    return finished(design.text, yamlAdapter.renameKey(design.parsed, holder.path, fieldName, newName), selection);
  }

  /** Sets a field's allowed values: a list, a map from value to meaning, or null to remove them. */
  function setValues(design, { interfaceId, owner, fieldName, values }) {
    const holder = fieldHolder(design, interfaceId, owner);
    if (holder.error) return holder;
    const current = valueAt(yamlAdapter.toData(design.parsed), holder.path.concat(fieldName));
    if (current === undefined) return unknownField(fieldName);
    const value = fieldValue(Object.assign(typeof current === 'string' ? { type: current } : withTypedRequired(current), { values }));
    if (value.error) return value;
    const draft = createDraft(design.text);
    writeField(draft, holder, fieldName, value);
    return finished(design.text, draftEdits(draft), Object.assign({}, holder.selection, { fieldName }));
  }

  /** Field data as read (failsafe text), with `required` as the boolean it is written as. */
  function withTypedRequired(fields) {
    if (!isMap(fields) || !['true', 'false'].includes(fields.required)) return fields;
    return Object.assign({}, fields, { required: fields.required === 'true' });
  }

  /** A field as it is written, keys in canonical order, or a refusal. */
  function fieldValue(field) {
    if (!isMap(field)) return refusal('invalid-value', 'A field is a map with at least a type');
    const problem = unknownFieldProblem(field, schema.FIELD_ORDER) || textProblem('type', field.type) ||
      ['meaning', 'unit', 'format', 'example'].map((key) => optionalTextProblem(key, field[key])).find(Boolean) ||
      requiredProblem(field.required) || valuesProblem(field.values) || constraintsProblem(field.constraints);
    if (problem) return problem;
    const required = typeof field.required === 'string' ? field.required === 'true' : field.required;
    return ordered(withoutNulls(Object.assign({}, field, {
      type: standardTypeText(field.type), required, values: withoutEmptyCollection(field.values),
      constraints: withoutEmptyList(field.constraints),
    })), schema.FIELD_ORDER);
  }

  /** How a field is written: its type alone, a flow map of syntactic keys, or a block map (spec §4.11). */
  function fieldForm(value) {
    const keys = Object.keys(value);
    if (keys.length === 1) return 'type';
    return keys.every((key) => SYNTAX_FIELD_KEYS.includes(key)) && !isMap(value.values) ? 'flow' : 'block';
  }

  /**
   * Writes the field `name` of the fields map `holder.path`. A field that keeps its form is edited key by key, so its
   * other keys and their comments stay; one that changes form is written over.
   */
  function writeField(draft, holder, name, value) {
    const path = holder.path.concat(name);
    const current = valueAt(yamlAdapter.toData(draft.parsed), path);
    const form = fieldForm(value);
    const currentForm = current === undefined ? null
      : typeof current === 'string' ? 'type' : isFlowCollectionAt(draft, path) ? 'flow' : 'block';
    if (form === 'type') writeFields(draft, holder.path, { [name]: value.type }, holder.order);
    else if (form === currentForm) writeFieldKeys(draft, path, value, current, form);
    else if (form === 'flow') writeRawValue(draft, holder.path, name, yamlAdapter.stringifyFragment(value, { flow: true }), holder.order);
    else writeBlockEntry(draft, holder.path, name, value, holder.order);
  }

  function writeFieldKeys(draft, path, value, current, form) {
    Object.keys(current).filter((key) => !hasOwn(value, key)).forEach((key) => applyStep(draft, yamlAdapter.deleteEntry(draft.parsed, path, key)));
    Object.entries(value).forEach(([key, item]) => {
      if (hasOwn(current, key) && sameData(current[key], item)) return;
      if (form === 'block' && key === 'values' && Array.isArray(item)) {
        writeRawValue(draft, path, key, yamlAdapter.stringifyFragment(item, { flow: true }), schema.FIELD_ORDER);
      } else if (form === 'block') {
        writeBlockEntry(draft, path, key, item, schema.FIELD_ORDER);
      } else {
        applyStep(draft, yamlAdapter.setEntry(draft.parsed, path, key, item, { order: schema.FIELD_ORDER }));
      }
    });
  }

  /** `{ path, order, operation, selection }` of the fields map `owner` names, or a refusal. */
  function fieldHolder(design, interfaceId, owner) {
    const declared = describedInterface(design, interfaceId);
    if (declared.error) return declared;
    if (isMap(owner) && typeof owner.typeName === 'string') {
      const type = declared.types.get(owner.typeName);
      if (!type) return unknownType(owner.typeName);
      return { path: type.path.concat('fields'), order: schema.TYPE_ORDER, operation: null,
        selection: { interfaceId: declared.id, typeName: type.name } };
    }
    if (!isMap(owner) || !PAYLOAD_PARTS.includes(owner.part)) {
      return refusal('invalid-owner', 'A field belongs to a type ({typeName}) or to an operation\'s input or output ({operationId, part})');
    }
    const operation = operationRecord(declared, owner.operationId);
    if (operation.error) return operation;
    const payload = fieldOf(valueAt(yamlAdapter.toData(design.parsed), operation.path), owner.part);
    if (typeof payload === 'string') {
      return refusal('not-inline', `The ${owner.part} of ${operation.id} is the type ${payload}; add the field to that type`);
    }
    return { path: operation.path.concat(owner.part), order: schema.OPERATION_ORDER, operation,
      selection: { interfaceId: declared.id, operationId: operation.id, part: owner.part } };
  }

  // ---- Interfaces: vocabulary ----

  /** Sets a term of the shared vocabulary (`interfaceId` null) or of an interface's own; a null meaning removes it. */
  function setVocabularyTerm(design, { interfaceId = null, term, meaning }) {
    const declared = interfaceId === null ? null : describedInterface(design, interfaceId);
    if (declared && declared.error) return declared;
    const problem = lineProblem('term', term) || (meaning === null ? null : textProblem('meaning', meaning));
    if (problem) return problem;
    const holderPath = declared ? declared.path.concat('vocabulary') : ['vocabulary'];
    const draft = createDraft(design.text);
    if (meaning === null) {
      if (valueAt(yamlAdapter.toData(draft.parsed), holderPath.concat(term)) !== undefined) removeAndPrune(draft, holderPath.concat(term));
    } else {
      const order = declared ? schema.INTERFACE_ORDER : schema.TOP_LEVEL_KEYS;
      applyStep(draft, yamlAdapter.setEntry(draft.parsed, holderPath, term, meaning, { order }));
    }
    return finished(design.text, draftEdits(draft), { interfaceId: declared ? declared.id : null, term });
  }

  // ---- Interfaces: lookups and checks ----

  function interfaceRecord(design, interfaceId) {
    const declared = typeof interfaceId === 'string' ? findInterface(design.model, interfaceId) : null;
    return declared || refusal('unknown-interface', `There is no interface ${JSON.stringify(interfaceId)}`);
  }

  /** The interface when it is written in the full form; a shorthand list holds syntax lines only. */
  function describedInterface(design, interfaceId) {
    const declared = interfaceRecord(design, interfaceId);
    return declared.error || !declared.shorthand ? declared : shorthandRefusal(declared);
  }

  function shorthandRefusal(declared) {
    return refusal('shorthand', `${declared.id} is a shorthand list of syntax lines; describe it fully first`);
  }

  function operationRecord(declared, operationId) {
    return declared.operations.find((operation) => operation.id === operationId) ||
      refusal('unknown-operation', `The interface ${declared.id} has no operation ${JSON.stringify(operationId)}`);
  }

  /** `{ declared, operation, selection }`, or a refusal; `described` refuses a shorthand interface. */
  function operationTarget(design, interfaceId, operationId, { described = false } = {}) {
    const declared = described ? describedInterface(design, interfaceId) : interfaceRecord(design, interfaceId);
    if (declared.error) return declared;
    const operation = operationRecord(declared, operationId);
    if (operation.error) return operation;
    return { declared, operation, selection: { interfaceId: declared.id, operationId: operation.id } };
  }

  /** The interface (`operationId` null) or operation whose restrictions and errors a command sets. */
  function semanticHolder(design, interfaceId, operationId) {
    if (operationId === null) {
      const declared = describedInterface(design, interfaceId);
      if (declared.error) return declared;
      return { path: declared.path, order: schema.INTERFACE_ORDER, operation: null, selection: { interfaceId: declared.id } };
    }
    const target = operationTarget(design, interfaceId, operationId, { described: true });
    if (target.error) return target;
    return { path: target.operation.path, order: schema.OPERATION_ORDER, operation: target.operation, selection: target.selection };
  }

  /** Writes `fields` into the holder's map; an operation written as its syntax line becomes a map first, if needed. */
  function writeHolderFields(draft, holder, fields) {
    const sets = Object.values(fields).some((value) => value !== null);
    if (holder.operation && sets) ensureOperationMap(draft, holder.operation);
    if (sets || isMap(valueAt(yamlAdapter.toData(draft.parsed), holder.path))) writeFields(draft, holder.path, fields, holder.order);
  }

  /** Writes an operation written as its syntax line as the map `{ syntax }`, so it can take more keys. */
  function ensureOperationMap(draft, operation) {
    const current = valueAt(yamlAdapter.toData(draft.parsed), operation.path);
    if (typeof current === 'string') replaceEntry(draft, operation.path, { syntax: current });
  }

  /** Lowercase element and interface ids, which new interface ids may not repeat (spec §4.11). */
  function takenInterfaceIds(model) {
    return new Set([...model.elements.keys(), ...model.interfaces.keys()].map((id) => id.toLowerCase()));
  }

  /**
   * A refusal when `id` is malformed or already used, ignoring case, by an element other than the provider
   * `providerId` or by an interface other than `own`; an interface may share its own provider's id (spec §4.11).
   */
  function newInterfaceIdProblem(model, id, providerId, own) {
    if (typeof id !== 'string' || !schema.ID_PATTERN.test(id)) return idFormatRefusal();
    const lower = id.toLowerCase();
    const elementTaken = [...model.elements.keys()].some((elementId) => elementId !== providerId && elementId.toLowerCase() === lower);
    return elementTaken || interfaceIdTaken(model, id, (candidate) => candidate === own) ? idTaken(id) : null;
  }

  function styleProblem(style) {
    if (style === null || style === undefined || schema.INTERFACE_STYLES.includes(style)) return null;
    return refusal('invalid-style', `A style is one of ${schema.INTERFACE_STYLES.join(', ')}`);
  }

  function operationValueProblem(field, value) {
    if (value === null) return field === 'syntax' ? refusal('invalid-syntax', 'An operation keeps its syntax line') : null;
    if (field === 'syntax') return lineProblem('syntax', value);
    if (!OPERATION_LIST_UPDATES.includes(field)) return textProblem(field, value);
    return isText(value) || (Array.isArray(value) && value.every(isText)) ? null : refusal('invalid-value', `${field} is a text or a list of texts`);
  }

  function lineProblem(field, value) {
    if (isText(value) && !/[\r\n]/.test(value)) return null;
    return refusal(`invalid-${field}`, `The ${field} is one line of text`);
  }

  function typeNameProblem(name) {
    return typeof name === 'string' && schema.TYPE_NAME_PATTERN.test(name) ? null
      : refusal('name-format', 'Type names start with a letter and use letters, digits, and underscores');
  }

  function fieldNameProblem(name) {
    return typeof name === 'string' && schema.FIELD_NAME_PATTERN.test(name) ? null
      : refusal('name-format', 'Field names start with a letter or an underscore and use letters, digits, - or _');
  }

  function requiredProblem(required) {
    if (required === undefined || required === null || typeof required === 'boolean' || ['true', 'false'].includes(required)) return null;
    return refusal('invalid-value', 'required is true or false');
  }

  function valuesProblem(values) {
    if (values === undefined || values === null) return null;
    if (Array.isArray(values) && values.every(isText)) return null;
    if (isMap(values) && Object.values(values).every((meaning) => meaning === null || typeof meaning === 'string')) return null;
    return refusal('invalid-value', 'values is a list of values or a map from value to meaning');
  }

  function constraintsProblem(constraints) {
    if (constraints === undefined || constraints === null || isText(constraints)) return null;
    return Array.isArray(constraints) && constraints.every(isText) ? null : refusal('invalid-value', 'constraints is a text or a list of texts');
  }

  /** A type expression in its standard spelling (`str` → `string`, `List<T>` → `T[]`); other text as written. */
  function standardTypeText(text) {
    const type = schema.parseTypeExpression(text);
    return type.invalid ? text : type.canonical;
  }

  function withoutEmptyCollection(value) {
    return isEmptyCollection(value) ? null : value;
  }

  /** Whether two values read the same, scalars compared as the text failsafe YAML reads. */
  function sameData(a, b) {
    const asText = (value) => (value !== null && typeof value === 'object'
      ? JSON.stringify(Object.entries(value).map(([key, item]) => [key, asText(item)])) : String(value));
    return asText(a) === asText(b);
  }

  function unknownType(name) {
    return refusal('unknown-type', `There is no type ${JSON.stringify(name)} in this interface`);
  }

  function unknownField(name) {
    return refusal('unknown-field', `There is no field ${JSON.stringify(name)}`);
  }

  function idFormatRefusal() {
    return refusal('id-format', 'Ids start with a letter and use letters, digits, - or _');
  }

  function idTaken(id) {
    return refusal('id-taken', `The id ${JSON.stringify(id)} is already used`);
  }

  function nameTaken(name) {
    return refusal('name-taken', `The name ${JSON.stringify(name)} is already used`);
  }

  return {
    expandProvidesShorthand, addInterface, updateInterface, removeInterface, changeInterfaceId, setRestrictions,
    addOperation, updateOperation, renameOperation, removeOperation, moveOperation, setError, addExample,
    updateExample, removeExample, setType, renameType, setField, renameField, setValues, setVocabularyTerm,
  };
});
