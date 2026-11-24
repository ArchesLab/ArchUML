(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-schema.js'), require('./c4-yaml.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.model = factory(parts.schema, parts.yaml);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, yamlAdapter) {
  'use strict';

  // Turns parsed design.yml data into the Model (spec §4) and reports schema diagnostics (spec §7.2).
  // Every scalar arrives as text (failsafe parsing); only the typed fields are converted here.

  const SOURCES = ['embed', 'file'];
  const TYPE_LABELS = { person: 'person', system: 'software system', container: 'container', component: 'component', code: 'code element' };
  const TYPE_PLURALS = { person: 'people', system: 'software systems', container: 'containers', component: 'components', code: 'code elements' };
  const CHILD_TYPE = { containers: 'container', components: 'component', code: 'code' };
  const RESPONSIBILITY_KINDS = ['know', 'do', 'decide'];
  const RESPONSIBILITY_KEYS = RESPONSIBILITY_KINDS.concat(['id', 'refines', 'requirements']);
  const CHOICE_KEYS = ['technology', 'styles', 'patterns', 'tactics'];
  const TECHNOLOGY_CHOICE_KEYS = ['chosen', 'alternatives', 'because', 'decision'];
  const PATTERN_KEYS = ['pattern', 'role', 'instance', 'decision'];
  const TEXT_LIST_FIELDS = ['owns', 'invariants', 'quality', 'tags'];
  const CODE_LIST_FIELDS = ['attributes', 'operations'];
  const CODE_REFERENCE_FIELDS = ['extends', 'implements'];
  // Fields that some element type allows, for telling a misplaced field from an unknown key.
  const ANY_ELEMENT_FIELD = new Set(Object.values(schema.FIELDS).flat());
  // Fields every software element (system, container, component, code) has: the RDD design slots plus
  // the common fields a person has too, so on a person only the design slots can be misplaced (spec §4.4).
  const SOFTWARE_ELEMENT_FIELDS = schema.ELEMENT_TYPES.filter((type) => type !== 'person')
    .map((type) => schema.FIELDS[type])
    .reduce((shared, fields) => shared.filter((field) => fields.includes(field)));
  const BOOLEAN_TEXT = { true: true, True: true, TRUE: true, false: false, False: false, FALSE: false };
  const CS188_COMPONENT_ID = /^CAN-/;
  const COLLABORATOR_KEYS = schema.COLLABORATOR_ORDER;
  const GROUP_KEYS = ['name', 'description'];
  const REQUIREMENT_KEYS = ['text', 'kind'];
  const SCENARIO_KEYS = ['title', 'description', 'steps'];
  const STEP_KEYS = schema.STEP_KEYS;
  const BRANCH_KEYS = ['when', 'steps'];
  const MULTI_BRANCH_FRAGMENTS = ['alt', 'par'];
  const ENVIRONMENT_KEYS = ['name', 'description', 'nodes'];
  const NODE_KEYS = ['name', 'description', 'kind', 'technology', 'instances', 'hosts', 'nodes', 'collaborators', 'tags'];
  const NODE_COLLABORATOR_KEYS = ['description', 'technology'];
  const NODE_USES_MESSAGE = '`uses` is not allowed on a deployment node collaborator; nodes carry the traffic, and the ' +
    'elements they host name the interfaces they use in their own collaborators';
  const DEPLOYABLE_TYPES = ['container', 'system'];
  const DECISION_KEYS = ['title', 'status', 'context', 'decision', 'alternatives', 'consequences', 'affects', 'supersedes', 'date'];
  const DIRECTIONS = ['down', 'right'];
  const ANNOTATIONS = schema.ANNOTATION_VALUES;
  const CHECKS_KEYS = ['ignore'];
  const IGNORE_KEYS = ['rule', 'element', 'because'];
  const WHOLE_NUMBER = /^[0-9]+$/;
  const PERSON_PROVIDES_MESSAGE = 'People do not provide interfaces; they may use one through `uses`';
  const CODE_PROVIDES_MESSAGE = 'Describe a class\'s operations in `operations`; describe the contract clients use on its component';
  const FLOW_COMMA_HINT = 'A comma inside a {…} value starts a new key; write this field as a block map, one key per line, ' +
    'or put the text in quotes.';
  const DECIMAL_NUMBER = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;

  /**
   * Normalizes a parsed document (c4-yaml `parse`) into `{ model, diagnostics }`. `model` is null only
   * when the YAML has syntax errors; otherwise every problem is a diagnostic and the model is best effort.
   */
  function normalize(parsed, { source = 'embed' } = {}) {
    if (!SOURCES.includes(source)) throw new RangeError(`Unknown source "${source}"; use embed or file`);
    if (parsed.errors.length > 0) return { model: null, diagnostics: parsed.errors.map(syntaxDiagnostic) };
    const context = { parsed, diagnostics: [] };
    const model = readDocument(yamlAdapter.toData(parsed), source, context);
    return { model, diagnostics: context.diagnostics };
  }

  function syntaxDiagnostic(error) {
    return diagnostic('yaml/syntax', 'error', error.message, { range: { start: error.range.start, end: error.range.end } });
  }

  // ---- Diagnostics ---------------------------------------------------------------------------

  function diagnostic(rule, severity, message, { hint = null, element = null, path = null, range = null } = {}) {
    return { rule, severity, category: rule.slice(0, rule.indexOf('/')), message, hint, element, path, range, fix: null };
  }

  /** Records an error at `path`; `part` picks the key or the value span. */
  function report(context, rule, message, path, { part = 'value', element = null, severity = 'error', hint = null } = {}) {
    const span = yamlAdapter.rangeOf(context.parsed, path, part);
    const range = span && { start: span.start, end: span.end };
    context.diagnostics.push(diagnostic(rule, severity, message, { hint, element, path, range }));
  }

  function code(text) {
    return '`' + text + '`';
  }

  function withSuggestion(message, word, candidates) {
    const suggestion = schema.suggest(word, candidates);
    return suggestion ? `${message}; did you mean ${code(suggestion)}?` : message;
  }

  // ---- Document ------------------------------------------------------------------------------

  function emptyModel(schemaVersion) {
    return {
      schemaVersion,
      meta: { name: null, description: null, status: null, enterprise: null, view: null },
      elements: new Map(),
      rootIds: [],
      relationships: [],
      responsibilityById: new Map(),
      requirements: new Map(),
      groups: new Map(),
      scenarios: new Map(),
      environments: new Map(),
      decisions: new Map(),
      views: new Map(),
      layout: new Map(),
      ignores: [],
      interfaces: new Map(),
      vocabulary: [],
    };
  }

  function readDocument(data, source, context) {
    if (data === null) return emptyModel(source === 'embed' ? schema.SCHEMA_VERSION : null);
    if (!isMap(data)) {
      report(context, 'schema/type', 'A design model must be a map of keys such as people and systems', []);
      return emptyModel(null);
    }
    if (isCs188File(data)) {
      report(context, 'schema/version', 'This is a CS 188 RDD file (schema_version with CAN- components); ' +
        'the C4 editor uses a different format, c4-design/1', ['schema_version'], { part: 'key' });
      return emptyModel(null);
    }
    const model = emptyModel(readSchemaVersion(data, source, context));
    checkKeys(context, data, [], schema.TOP_LEVEL_KEYS, 'at the top level');
    model.meta = readMeta(data, context);
    const elementFieldsById = readElements(data, model, context);
    readSections(data, model, elementFieldsById, context);
    return model;
  }

  /**
   * Reads every section after the elements tree, in dependency order: the namespaces that references point
   * into (requirements, groups, responsibilities, decisions) come before the sections that refer to them.
   */
  function readSections(data, model, elementFieldsById, context) {
    const reader = { model, context };
    model.vocabulary = readVocabulary(context, data.vocabulary, ['vocabulary'], null);
    model.requirements = readRequirements(reader, data.requirements);
    model.groups = readGroups(reader, data.groups, elementFieldsById);
    model.responsibilityById = indexResponsibilities(reader);
    model.decisions = readDecisions(reader, data.decisions);
    checkDecisionReferences(reader, data.decisions);
    model.elements.forEach((element) => checkElementReferences(reader, element, elementFieldsById.get(element.id)));
    checkRealizedResponsibilities(reader, data);
    model.relationships = readRelationships(reader, elementFieldsById);
    resolveRelationshipUses(reader);
    model.scenarios = readScenarios(reader, data.scenarios);
    model.environments = readEnvironments(reader, data.deployment);
    model.views = readViews(reader, data.views);
    model.layout = readLayout(reader, data.layout);
    model.ignores = readIgnores(reader, data.checks);
  }

  function isCs188File(data) {
    return 'schema_version' in data && isMap(data.components) &&
      Object.keys(data.components).some((id) => CS188_COMPONENT_ID.test(id));
  }

  function readSchemaVersion(data, source, context) {
    if (!('schema' in data)) {
      if (source === 'embed') return schema.SCHEMA_VERSION;
      context.diagnostics.push(diagnostic('schema/version', 'info',
        `The file does not declare its format; add ${code('schema: ' + schema.SCHEMA_VERSION)}`));
      return null;
    }
    if (data.schema === schema.SCHEMA_VERSION) return schema.SCHEMA_VERSION;
    report(context, 'schema/version', `Unknown schema version ${code(String(data.schema))}; ` +
      `this editor reads ${code(schema.SCHEMA_VERSION)}`, ['schema']);
    return null;
  }

  function readMeta(data, context) {
    const text = (key) => readText(context, data[key], [key]);
    return {
      name: text('name'),
      description: text('description'),
      status: readEnum(context, data.status, ['status'], schema.STATUSES, 'status'),
      enterprise: text('enterprise'),
      view: text('view'),
    };
  }

  // ---- Keys ----------------------------------------------------------------------------------

  function isExtensionKey(key) {
    return key.startsWith('x-');
  }

  /** Reports keys of `map` outside `allowed` (x-* keys are always allowed); `where` ends the message. */
  function checkKeys(context, map, path, allowed, where, { element = null, misplaced = null } = {}) {
    for (const key of Object.keys(map)) {
      if (allowed.includes(key) || isExtensionKey(key)) continue;
      const keyPath = path.concat(key);
      const misplacedMessage = misplaced && misplaced(key);
      if (misplacedMessage) {
        report(context, 'schema/misplaced-field', misplacedMessage, keyPath, { part: 'key', element });
      } else {
        report(context, 'schema/unknown-key', withSuggestion(`Unknown key ${code(key)} ${where}`, key, allowed),
          keyPath, { part: 'key', element, hint: isStrayFlowText(map, key) ? FLOW_COMMA_HINT : null });
      }
    }
  }

  // `{meaning: total units, after this attempt}`: text after a comma inside a flow map reads as a key without a value.
  function isStrayFlowText(map, key) {
    return map[key] == null && /\s/.test(key);
  }

  /** Why `field` does not belong on an element of `type`, or null when no element type has it. */
  function misplacedFieldMessage(field, type, id) {
    if (!ANY_ELEMENT_FIELD.has(field)) return null;
    if (type === 'person' && field === 'provides') return PERSON_PROVIDES_MESSAGE;
    const subject = `${code(field)} is not allowed on ${TYPE_LABELS[type]} ${code(id)}`;
    if (type === 'person' && SOFTWARE_ELEMENT_FIELDS.includes(field)) {
      return `${subject}: a person is an actor, not a design participant; put the person's goal in ${code('description')}`;
    }
    const homes = schema.ELEMENT_TYPES.filter((other) => schema.FIELDS[other].includes(field))
      .map((other) => TYPE_PLURALS[other]);
    return `${subject}; it belongs on ${listText(homes)}`;
  }

  /** Reports an id that does not match the id pattern; `part` says whether the id is a key or a value. */
  function checkIdFormat(context, id, path, { part = 'key', element = null } = {}) {
    if (schema.ID_PATTERN.test(id)) return;
    report(context, 'schema/id-format', `The id ${code(id)} must start with a letter and contain only letters, ` +
      'digits, hyphens, and underscores', path, { part, element });
  }

  function listText(words) {
    return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  }

  // ---- Elements ------------------------------------------------------------------------------

  /**
   * Builds the elements tree and the interfaces its elements provide; returns each element's checked field map, which
   * later sections read.
   */
  function readElements(data, model, context) {
    const walker = { model, context, enterprise: model.meta.enterprise !== null, fieldsById: new Map(), interfaces: [] };
    model.rootIds = readElementMap(walker, data.people, ['people'], 'person', null)
      .concat(readElementMap(walker, data.systems, ['systems'], 'system', null));
    registerInterfaces(walker);
    return walker.fieldsById;
  }

  /** Reads a map of elements of one type; returns the ids it added, in document order. */
  function readElementMap(walker, entries, path, type, parentId) {
    if (entries == null) return [];
    if (!isMap(entries)) {
      report(walker.context, 'schema/type', `${code(path[path.length - 1])} must be a map from id to element`, path);
      return [];
    }
    const added = [];
    for (const [id, value] of Object.entries(entries)) {
      if (readElement(walker, id, value, path.concat(id), type, parentId)) added.push(id);
    }
    return added;
  }

  /** Adds one element and its children; false when its id is already taken. */
  function readElement(walker, id, value, path, type, parentId) {
    const { model, context } = walker;
    if (model.elements.has(id)) {
      const first = model.elements.get(id);
      report(context, 'model/duplicate-id', `The id ${code(id)} is already used by the ${TYPE_LABELS[first.type]} ` +
        `at ${first.path.join('.')}; element ids are unique across the model`, path, { part: 'key', element: id });
      return false;
    }
    checkIdFormat(context, id, path, { element: id });
    const fields = elementFields(context, value, path, type, id);
    // `authored` is the element's value as written (failsafe data, children included), read-only; `same_as_seed`
    // compares it, so an edit elsewhere that leaves a reference of this element dangling does not change it (spec §8).
    const element = Object.assign({ id, type, parentId, childIds: [], path }, readFields(walker, fields, path, type, id),
      { authored: value === undefined ? null : value });
    if (schema.FIELDS[type].includes('provides')) readProvides(walker, element, fields.provides);
    model.elements.set(id, element);
    walker.fieldsById.set(id, fields);
    const childKey = schema.CHILD_KEY[type];
    if (childKey) element.childIds = readElementMap(walker, fields[childKey], path.concat(childKey), CHILD_TYPE[childKey], id);
    return true;
  }

  /** The element's field map after key checks; an empty or non-map value reads as no fields. */
  function elementFields(context, value, path, type, id) {
    if (value == null) return {};
    if (!isMap(value)) {
      report(context, 'schema/type', `The ${TYPE_LABELS[type]} ${code(id)} must be a map of fields`, path, { element: id });
      return {};
    }
    checkKeys(context, value, path, schema.FIELDS[type], `on ${TYPE_LABELS[type]} ${code(id)}`,
      { element: id, misplaced: (key) => misplacedFieldMessage(key, type, id) });
    return value;
  }

  function readFields(walker, fields, path, type, id) {
    const context = walker.context;
    const allows = (field) => schema.FIELDS[type].includes(field);
    const at = (field) => path.concat(field);
    const text = (field) => (allows(field) ? readText(context, fields[field], at(field), id) : null);
    const textList = (field) => (allows(field) ? readTextList(context, fields[field], at(field), id) : []);
    const flag = (field, fallback) => (allows(field) ? readBoolean(context, fields[field], at(field), id, fallback) : null);
    const result = {
      kind: readKind(context, fields, path, type, id),
      name: text('name') || id,
      description: text('description'),
      technology: text('technology'),
      external: flag('external', false),
      inEnterprise: flag('in_enterprise', walker.enterprise),
      group: text('group'),
      stereotypes: allows('stereotypes')
        ? readEnumList(context, fields.stereotypes, at('stereotypes'), schema.STEREOTYPES, 'stereotype', id) : [],
      responsibilities: allows('responsibilities') ? readResponsibilities(context, fields.responsibilities, at('responsibilities'), id) : [],
      choices: allows('choices') ? readChoices(context, fields.choices, at('choices'), id) : null,
      code: type === 'code' ? readCodeFields(context, fields, path, id) : null,
      source: text('source'),
      provides: [],
      interfaceIds: [],
    };
    TEXT_LIST_FIELDS.forEach((field) => { result[field] = textList(field); });
    return result;
  }

  function readKind(context, fields, path, type, id) {
    if (type === 'container') return readEnum(context, fields.kind, path.concat('kind'), schema.CONTAINER_KINDS, 'container kind', id) || 'application';
    if (type === 'code') return readEnum(context, fields.kind, path.concat('kind'), schema.CODE_KINDS, 'code kind', id) || 'class';
    return null;
  }

  function readCodeFields(context, fields, path, id) {
    const result = {};
    CODE_LIST_FIELDS.forEach((field) => { result[field] = readTextList(context, fields[field], path.concat(field), id); });
    CODE_REFERENCE_FIELDS.forEach((field) => { result[field] = readOneOrMany(context, fields[field], path.concat(field), id); });
    return result;
  }

  // ---- Responsibilities ----------------------------------------------------------------------

  function readResponsibilities(context, value, path, ownerId) {
    const items = readList(context, value, path, ownerId);
    return items.map((item, index) => readResponsibility(context, item, path.concat(index), ownerId, index));
  }

  function readResponsibility(context, item, path, ownerId, index) {
    const base = { id: null, kind: null, text: '', refines: [], requirements: [], ownerId, index, path };
    if (typeof item === 'string') return Object.assign(base, schema.parseResponsibilityShorthand(item));
    if (!isMap(item)) {
      report(context, 'schema/type', 'A responsibility is a text or a map with one of know, do, or decide', path, { element: ownerId });
      return base;
    }
    checkKeys(context, item, path, RESPONSIBILITY_KEYS, 'in a responsibility', { element: ownerId });
    const kinds = RESPONSIBILITY_KINDS.filter((kind) => kind in item);
    if (kinds.length !== 1) {
      report(context, 'schema/type', 'A responsibility map needs exactly one of know, do, or decide', path, { element: ownerId });
    }
    const kind = kinds[0] || null;
    return Object.assign(base, {
      id: readText(context, item.id, path.concat('id'), ownerId),
      kind,
      text: (kind && readText(context, item[kind], path.concat(kind), ownerId)) || '',
      refines: readOneOrMany(context, item.refines, path.concat('refines'), ownerId),
      requirements: readOneOrMany(context, item.requirements, path.concat('requirements'), ownerId),
    });
  }

  // ---- Choices -------------------------------------------------------------------------------

  /** Design choices (spec §4.7) of an element; null when none are declared. */
  function readChoices(context, value, path, element) {
    if (value == null) return null;
    if (!isMap(value)) {
      report(context, 'schema/type', 'choices must be a map of technology, styles, patterns, and tactics', path, { element });
      return null;
    }
    checkKeys(context, value, path, CHOICE_KEYS, 'in choices', { element });
    return {
      technology: readTechnologyChoice(context, value.technology, path.concat('technology'), element),
      styles: readTextList(context, value.styles, path.concat('styles'), element),
      patterns: readList(context, value.patterns, path.concat('patterns'), element)
        .map((item, index) => readPatternChoice(context, item, path.concat('patterns', index), element)),
      tactics: readTextList(context, value.tactics, path.concat('tactics'), element),
    };
  }

  function readTechnologyChoice(context, value, path, element) {
    if (value == null) return null;
    if (!isMap(value)) {
      report(context, 'schema/type', 'A technology choice is a map of chosen, alternatives, because, and decision', path, { element });
      return null;
    }
    checkKeys(context, value, path, TECHNOLOGY_CHOICE_KEYS, 'in a technology choice', { element });
    const text = (key) => readText(context, value[key], path.concat(key), element);
    return {
      chosen: text('chosen'),
      alternatives: readTextList(context, value.alternatives, path.concat('alternatives'), element),
      because: text('because'),
      decision: text('decision'),
    };
  }

  function readPatternChoice(context, item, path, element) {
    const base = { pattern: null, role: null, instance: null, decision: null };
    if (typeof item === 'string') return Object.assign(base, schema.parsePatternShorthand(item));
    if (!isMap(item)) {
      report(context, 'schema/type', 'A pattern is a text such as "Strategy: Context" or a map with pattern and role', path, { element });
      return base;
    }
    checkKeys(context, item, path, PATTERN_KEYS, 'in a pattern', { element });
    PATTERN_KEYS.forEach((key) => { base[key] = readText(context, item[key], path.concat(key), element); });
    return base;
  }

  // ---- Interfaces (spec §4.11) ---------------------------------------------------------------
  //
  // On systems, containers, and components `provides` holds interfaces: a shorthand list of syntax lines (one interface
  // named after its element) or a map from interface id to interface. Code elements keep Milestone 1's signature
  // strings. Keys under `fields`, inline field maps, `errors`, `values`, `vocabulary`, and example values are user
  // data: they are neither checked as keys nor converted; only a field's `required` becomes a boolean. References
  // (`realizes`, types named by `input`, `output`, and field types) are resolved by later passes.

  /** Sets `element.provides` (flat syntax lines) and queues the element's interfaces for registration. */
  function readProvides(walker, element, value) {
    const path = element.path.concat('provides');
    if (element.type === 'code') {
      element.provides = readCodeProvides(walker.context, value, path, element.id);
      return;
    }
    const interfaces = readInterfaces(walker, element, value, path);
    element.provides = interfaces.flatMap((declared) => declared.operations.map((op) => op.syntax === null ? op.id : op.syntax));
    walker.interfaces.push(...interfaces);
  }

  function readCodeProvides(context, value, path, element) {
    if (!isMap(value)) return readTextList(context, value, path, element);
    if (Object.keys(value).length > 0) report(context, 'schema/misplaced-field', CODE_PROVIDES_MESSAGE, path, { part: 'key', element });
    return [];
  }

  /** The interfaces a `provides` value declares; an empty list or map declares none. */
  function readInterfaces(walker, element, value, path) {
    if (value == null) return [];
    if (Array.isArray(value)) return value.length > 0 ? readShorthandInterface(walker.context, element, value, path) : [];
    if (isMap(value)) {
      return Object.entries(value).map(([id, item]) => {
        checkIdFormat(walker.context, id, path.concat(id), { element: element.id });
        return readInterface(walker, element.id, id, item, path.concat(id));
      });
    }
    report(walker.context, 'schema/type', `${code('provides')} must be a list of syntax lines or a map from interface id to interface`,
      path, { element: element.id });
    return [];
  }

  /** A list of syntax lines is one interface whose id is the element's id (spec §4.11, form 1). */
  function readShorthandInterface(context, element, items, path) {
    const other = items.findIndex((item) => typeof item !== 'string');
    if (other >= 0) {
      report(context, 'schema/type', `A ${code('provides')} list holds syntax lines only; write interfaces with more detail ` +
        'as a map from interface id to interface instead of the list', path.concat(other), { element: element.id });
      return [];
    }
    const taken = new Set();
    const operations = items.map((syntax, index) => Object.assign(emptyOperation(element.id, schema.deriveOperationId(syntax, taken),
      path.concat(index)), { syntax, placeholders: schema.placeholders(syntax) }));
    return [Object.assign(emptyInterface(element.id, element.id, path), {
      shorthand: true, name: `${element.name} interface`, operations,
    })];
  }

  function emptyInterface(id, providerId, path) {
    return {
      id, providerId, shorthand: false, documentFormat: false, name: id, description: null, style: null, technology: null,
      version: null, restrictions: [], errors: [], operations: [], types: new Map(), vocabulary: [], path,
    };
  }

  function emptyOperation(interfaceId, id, path) {
    return {
      id, interfaceId, syntax: null, placeholders: [], input: null, output: null, purpose: null, sideEffects: [],
      restrictions: [], errors: [], examples: [], realizes: [], path,
    };
  }

  function readInterface(walker, providerId, id, item, path) {
    const { context } = walker;
    const fields = entryFields(walker, item, path, schema.INTERFACE_ORDER, `interface ${code(id)}`, providerId);
    const at = (key) => path.concat(key);
    const text = (key) => readText(context, fields[key], at(key), providerId);
    const declared = Object.assign(emptyInterface(id, providerId, path), {
      name: text('name') || id,
      description: text('description'),
      style: readEnum(context, fields.style, at('style'), schema.INTERFACE_STYLES, 'interface style', providerId),
      technology: text('technology'),
      version: text('version'),
      restrictions: readOneOrMany(context, fields.restrictions, at('restrictions'), providerId),
      errors: readErrors(walker, providerId, fields.errors, at('errors')),
      operations: readOperations(walker, providerId, id, fields.operations, at('operations')),
      types: readTypes(walker, providerId, fields.types, at('types')),
      vocabulary: readVocabulary(context, fields.vocabulary, at('vocabulary'), providerId),
    });
    // A document format (a file or record two systems exchange) has types and no operations.
    declared.documentFormat = declared.operations.length === 0 && declared.types.size > 0;
    markDefinedTypes(declared);
    return declared;
  }

  /** Sets `defined` on every type reference of an interface: a primitive or one of its own types (types are local). */
  function markDefinedTypes(declared) {
    const mark = (ref) => {
      if (ref && !ref.invalid) ref.defined = ref.primitive || declared.types.has(ref.name);
    };
    const markFields = (fields) => fields.forEach((field) => mark(field.type));
    const markUse = (use) => {
      if (use === null) return;
      if (use.fields) markFields(use.fields);
      else mark(use.type);
    };
    declared.operations.forEach((operation) => [operation.input, operation.output].forEach(markUse));
    declared.types.forEach((type) => markFields(type.fields));
  }

  /** The `[key, value, path]` entries of a map of named parts; a value that is not a map is reported. */
  function namedEntries(context, value, path, element) {
    if (value == null) return [];
    if (!isMap(value)) {
      report(context, 'schema/type', `${code(path[path.length - 1])} must be a map from name to entry`, path, { element });
      return [];
    }
    return Object.entries(value).map(([key, item]) => [key, item, path.concat(key)]);
  }

  /** Reports a name that does not match `pattern`, whose rule `rule` describes, at its key. */
  function checkNameFormat(context, name, path, pattern, rule, element) {
    if (pattern.test(name)) return;
    report(context, 'schema/id-format', `The name ${code(name)} must ${rule}`, path, { part: 'key', element });
  }

  function readOperations(walker, providerId, interfaceId, value, path) {
    return namedEntries(walker.context, value, path, providerId).map(([id, item, itemPath]) => {
      checkIdFormat(walker.context, id, itemPath, { element: providerId });
      return readOperation(walker, providerId, interfaceId, id, item, itemPath);
    });
  }

  /** An operation is its syntax line alone or a map (spec §4.11). */
  function readOperation(walker, providerId, interfaceId, id, item, path) {
    const operation = emptyOperation(interfaceId, id, path);
    const { context } = walker;
    const fields = typeof item === 'string' ? { syntax: item }
      : entryFields(walker, item, path, schema.OPERATION_ORDER, `operation ${code(id)}`, providerId);
    const at = (key) => path.concat(key);
    const syntax = readText(context, fields.syntax, at('syntax'), providerId);
    return Object.assign(operation, {
      syntax,
      placeholders: syntax === null ? [] : schema.placeholders(syntax),
      input: readTypeUse(walker, providerId, fields.input, at('input')),
      output: readTypeUse(walker, providerId, fields.output, at('output')),
      purpose: readText(context, fields.purpose, at('purpose'), providerId),
      sideEffects: readOneOrMany(context, fields.side_effects, at('side_effects'), providerId),
      restrictions: readOneOrMany(context, fields.restrictions, at('restrictions'), providerId),
      errors: readErrors(walker, providerId, fields.errors, at('errors')),
      examples: readList(context, fields.examples, at('examples'), providerId)
        .map((example, index) => readExample(walker, providerId, example, at('examples').concat(index))),
      realizes: readOneOrMany(context, fields.realizes, at('realizes'), providerId),
    });
  }

  /** `input` and `output`: a type expression or an inline field map. */
  function readTypeUse(walker, providerId, value, path) {
    if (value == null) return null;
    if (typeof value === 'string') return { typeText: value, type: schema.parseTypeExpression(value) };
    if (isMap(value)) return { fields: readFieldMap(walker, providerId, value, path) };
    report(walker.context, 'schema/type', `${code(path[path.length - 1])} must be a type such as ${code('Order')} or a map of fields`,
      path, { element: providerId });
    return null;
  }

  function readTypes(walker, providerId, value, path) {
    const types = new Map();
    for (const [name, item, itemPath] of namedEntries(walker.context, value, path, providerId)) {
      checkNameFormat(walker.context, name, itemPath, schema.TYPE_NAME_PATTERN,
        'start with a letter and contain only letters, digits, and underscores', providerId);
      const fields = entryFields(walker, item, itemPath, schema.TYPE_ORDER, `type ${code(name)}`, providerId);
      types.set(name, {
        name,
        description: readText(walker.context, fields.description, itemPath.concat('description'), providerId),
        fields: readFieldMap(walker, providerId, fields.fields, itemPath.concat('fields')),
        path: itemPath,
      });
    }
    return types;
  }

  function readFieldMap(walker, providerId, value, path) {
    return namedEntries(walker.context, value, path, providerId).map(([name, item, itemPath]) => {
      checkNameFormat(walker.context, name, itemPath, schema.FIELD_NAME_PATTERN,
        'start with a letter or an underscore and contain only letters, digits, hyphens, and underscores', providerId);
      return readField(walker, providerId, name, item, itemPath);
    });
  }

  /** A field is its type alone or a map (spec §4.11); `required` is the one converted value, defaulting to true. */
  function readField(walker, providerId, name, item, path) {
    const { context } = walker;
    const fields = typeof item === 'string' ? { type: item }
      : entryFields(walker, item, path, schema.FIELD_ORDER, `field ${code(name)}`, providerId);
    const at = (key) => path.concat(key);
    const text = (key) => readText(context, fields[key], at(key), providerId);
    const typeText = text('type');
    const values = readValues(context, fields.values, at('values'), providerId);
    return {
      name,
      typeText,
      type: typeText === null ? null : schema.parseTypeExpression(typeText),
      meaning: text('meaning'),
      unit: text('unit'),
      format: text('format'),
      required: readBoolean(context, fields.required, at('required'), providerId, true),
      values: values && values.values,
      valuesForm: values && values.form,
      constraints: readOneOrMany(context, fields.constraints, at('constraints'), providerId),
      example: fields.example == null ? null : fields.example,
      path,
    };
  }

  /** Allowed values: a list (values without meanings) or a map from value to meaning; null when absent. */
  function readValues(context, value, path, element) {
    if (value == null) return null;
    if (Array.isArray(value)) {
      const values = readTextList(context, value, path, element).map((text) => ({ value: text, meaning: null }));
      return { values, form: 'list' };
    }
    if (isMap(value)) {
      const values = Object.entries(value).map(([text, meaning]) =>
        ({ value: text, meaning: readText(context, meaning, path.concat(text), element) }));
      return { values, form: 'map' };
    }
    report(context, 'schema/type', `${code('values')} must be a list of values or a map from value to meaning`, path, { element });
    return null;
  }

  /** Errors map a name to when and why they happen, as text or `{when, code}`; `code` stays text. */
  function readErrors(walker, providerId, value, path) {
    return namedEntries(walker.context, value, path, providerId).map(([name, item, itemPath]) => {
      checkIdFormat(walker.context, name, itemPath, { element: providerId });
      const fields = typeof item === 'string' ? { when: item }
        : entryFields(walker, item, itemPath, schema.ERROR_KEYS, `error ${code(name)}`, providerId);
      const text = (key) => readText(walker.context, fields[key], itemPath.concat(key), providerId);
      return { name, code: text('code'), when: text('when'), path: itemPath };
    });
  }

  /** An example keeps its input and output as failsafe data and as their one-line source text. */
  function readExample(walker, providerId, item, path) {
    const { context } = walker;
    const example = { input: null, output: null, inputText: null, outputText: null, note: null, path };
    if (!isMap(item)) {
      report(context, 'schema/type', 'An example is a map of input, output, and note', path, { element: providerId });
      return example;
    }
    checkKeys(context, item, path, schema.EXAMPLE_KEYS, 'in an example', { element: providerId });
    if (!schema.EXAMPLE_KEYS.some((key) => key in item)) {
      report(context, 'schema/value', 'An example needs at least one of input, output, and note', path, { element: providerId });
    }
    const source = (key) => (item[key] == null ? null : yamlAdapter.flowText(context.parsed, path.concat(key)));
    return Object.assign(example, {
      input: item.input == null ? null : item.input,
      output: item.output == null ? null : item.output,
      inputText: source('input'),
      outputText: source('output'),
      note: readText(context, item.note, path.concat('note'), providerId),
    });
  }

  /** A vocabulary maps free-text terms to their meanings (spec §4.11). */
  function readVocabulary(context, value, path, element) {
    return namedEntries(context, value, path, element)
      .map(([term, meaning, termPath]) => ({ term, meaning: readText(context, meaning, termPath, element), path: termPath }));
  }

  /**
   * Adds the queued interfaces to `model.interfaces` in document order. Interface ids share the element namespace,
   * ignoring case; a shorthand interface carries its own element's id (spec §4.11). A duplicate is reported and left out.
   */
  function registerInterfaces(walker) {
    const { model, context } = walker;
    for (const declared of walker.interfaces) {
      const clash = interfaceIdClash(model, declared);
      if (clash) {
        report(context, 'model/duplicate-id', `The interface id ${code(declared.id)} is already ${clash}; interface ids share ` +
          'the element namespace and are unique ignoring case', declared.path, { part: 'key', element: declared.providerId });
        continue;
      }
      model.interfaces.set(declared.id, declared);
      model.elements.get(declared.providerId).interfaceIds.push(declared.id);
    }
  }

  /** What already uses the id of `declared`, ignoring case, as a phrase; null when the id is free. */
  function interfaceIdClash(model, declared) {
    const id = declared.id.toLowerCase();
    const sameId = (other) => other.toLowerCase() === id;
    const element = [...model.elements.values()]
      .find((candidate) => sameId(candidate.id) && candidate.id !== declared.providerId);
    if (element) return `the id of the ${elementLabel(element)}`;
    const first = [...model.interfaces.values()].find((candidate) => sameId(candidate.id));
    return first ? `used by the interface at ${first.path.join('.')}` : null;
  }

  // ---- Sections: shared readers --------------------------------------------------------------

  function capitalized(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** Reads a map of id → entry into a Map, checking each id; `readEntry` returns the entry, or null to leave it out. */
  function readIdMap(reader, value, path, readEntry) {
    const entries = new Map();
    if (value == null) return entries;
    if (!isMap(value)) {
      report(reader.context, 'schema/type', `${code(path[path.length - 1])} must be a map from id to entry`, path);
      return entries;
    }
    for (const [id, item] of Object.entries(value)) {
      const entryPath = path.concat(id);
      checkIdFormat(reader.context, id, entryPath);
      const entry = readEntry(id, item, entryPath);
      if (entry) entries.set(id, entry);
    }
    return entries;
  }

  /**
   * The field map of a section entry after key checks; an empty or non-map value reads as no fields. `misplaced`
   * explains a key that is known elsewhere (see checkKeys).
   */
  function entryFields(reader, item, path, allowed, label, element = null, misplaced = null) {
    if (item == null) return {};
    if (!isMap(item)) {
      report(reader.context, 'schema/type', `${capitalized(label)} must be a map of ${listText(allowed)}`, path, { element });
      return {};
    }
    checkKeys(reader.context, item, path, allowed, `in ${label}`, { element, misplaced });
    return item;
  }

  /** The `[targetId, value, path]` entries of a collaborators map (spec §4.6). */
  function collaboratorTargets(reader, value, path, element) {
    if (value == null) return [];
    if (!isMap(value)) {
      report(reader.context, 'schema/type', `${code('collaborators')} must be a map from target id to relationship`, path, { element });
      return [];
    }
    return Object.entries(value).map(([targetId, item]) => [targetId, item, path.concat(targetId)]);
  }

  /** The `[item, path]` pairs of one collaborator value: a list gives several relationships to the same target. */
  function collaboratorItems(value, path) {
    return Array.isArray(value) ? value.map((item, index) => [item, path.concat(index)]) : [[value, path]];
  }

  // ---- References ----------------------------------------------------------------------------

  /** True when `ancestorId` contains the element `id` at any depth. */
  function isAncestor(model, ancestorId, id) {
    for (let current = model.elements.get(id); current && current.parentId; current = model.elements.get(current.parentId)) {
      if (current.parentId === ancestorId) return true;
    }
    return false;
  }

  function isSameOrInside(model, id, containerId) {
    return id === containerId || isAncestor(model, containerId, id);
  }

  /**
   * Whether a relationship from `sourceId` to `targetId` may ask `ownerId` for help (spec §4.6, §4.11 case 1): the owner
   * is the target, a part of it, or an element that contains the target and is neither the source nor contains it.
   */
  function servesRequest(model, ownerId, sourceId, targetId) {
    if (isSameOrInside(model, ownerId, targetId)) return true;
    return isAncestor(model, ownerId, targetId) && ownerId !== sourceId && !isAncestor(model, ownerId, sourceId);
  }

  function isBroker(model, id) {
    const element = model.elements.get(id);
    return Boolean(element) && element.type === 'container' && schema.BROKER_KINDS.includes(element.kind);
  }

  /** The interface with `id`, compared ignoring case (interface ids are unique ignoring case); null when there is none. */
  function interfaceOf(model, id) {
    const exact = model.interfaces.get(id);
    if (exact) return exact;
    const lower = id.toLowerCase();
    return [...model.interfaces.values()].find((declared) => declared.id.toLowerCase() === lower) || null;
  }

  /**
   * How a relationship from `sourceId` to `targetId` uses the interface `interfaceId` (decision J7, spec §4.11): a
   * `request` to its provider, the source's own `emit` to a subscriber, a `channel` from the source's own interface into
   * a queue or topic, or a `broker-peer` use of an interface whose provider has its own relationship to that queue or
   * topic. Null when J7 does not allow the use or the interface does not exist. Reads `model.relationships`.
   */
  function useKind(model, sourceId, targetId, interfaceId) {
    const declared = interfaceOf(model, interfaceId);
    if (!declared) return null;
    const { providerId } = declared;
    if (servesRequest(model, providerId, sourceId, targetId)) return 'request';
    const broker = isBroker(model, targetId);
    if (providerId === sourceId) {
      if (broker) return 'channel';
      return schema.EMITTER_STYLES.includes(declared.style) ? 'emit' : null;
    }
    const providerReachesBroker = model.relationships
      .some((relationship) => relationship.sourceId === providerId && relationship.targetId === targetId);
    return broker && providerReachesBroker ? 'broker-peer' : null;
  }

  /**
   * The interface a parsed `uses` entry names, with its operation checked; null when either is unknown (reported, with a
   * suggestion, and with the element's interfaces when the entry names an element instead, spec §4.11).
   */
  function usedInterface(reader, entry, element) {
    const { model, context } = reader;
    const declared = interfaceOf(model, entry.interfaceId);
    if (!declared) {
      report(context, 'model/unknown-reference',
        withSuggestion(`There is no interface ${code(entry.interfaceId)}`, entry.interfaceId, [...model.interfaces.keys()]),
        entry.path, { element, hint: elementInsteadOfInterfaceHint(model, entry.interfaceId) });
      return null;
    }
    if (entry.operationId === null || declared.operations.some((operation) => operation.id === entry.operationId)) return declared;
    const operationIds = declared.operations.map((operation) => operation.id);
    const suggestion = schema.suggest(entry.operationId, operationIds);
    const advice = suggestion ? `did you mean ${code(suggestion)}?`
      : operationIds.length > 0 ? `its operations are ${listText(operationIds.map(code))}` : 'it has no operations';
    report(context, 'model/unknown-reference', `There is no operation ${code(entry.operationId)} in the interface ` +
      `${code(declared.id)}; ${advice}`, entry.path, { element });
    return null;
  }

  function elementInsteadOfInterfaceHint(model, id) {
    const element = model.elements.get(id);
    if (!element) return null;
    return element.interfaceIds.length > 0
      ? `${id} is an element; name one of its interfaces: ${element.interfaceIds.join(', ')}`
      : `${id} is an element and provides no interface yet`;
  }

  /** A `uses` text as `{ interfaceId, operationId, text, path }`; null when malformed (reported as `schema/value`). */
  function parseUsesEntry(context, text, path, element) {
    const ref = schema.parseUsesRef(text);
    if (!ref.error) return { interfaceId: ref.interfaceId, operationId: ref.operationId, text, path };
    report(context, 'schema/value', `${code(text)} does not name an interface; write ${code('<interface-id>')} or ` +
      `${code('<interface-id>.<operation-id>')}`, path, { element });
    return null;
  }

  /** Reports `model/unknown-reference` unless `table` has `id`; returns whether it does. */
  function resolves(reader, table, id, path, label, { part = 'value', element = null } = {}) {
    if (table.has(id)) return true;
    report(reader.context, 'model/unknown-reference', withSuggestion(`There is no ${label} ${code(id)}`, id, [...table.keys()]),
      path, { part, element });
    return false;
  }

  /** The element `id` refers to, or null when there is none (reported). */
  function elementReference(reader, id, path, { part = 'value', element = null } = {}) {
    const found = resolves(reader, reader.model.elements, id, path, 'element', { part, element });
    return found ? reader.model.elements.get(id) : null;
  }

  function elementLabel(element) {
    return `${TYPE_LABELS[element.type]} ${code(element.id)}`;
  }

  function checkElementReferences(reader, element, fields) {
    checkGroupReference(reader, element);
    const items = Array.isArray(fields.responsibilities) ? fields.responsibilities : [];
    element.responsibilities.forEach((responsibility) => checkResponsibilityReferences(reader, responsibility, items[responsibility.index]));
    if (element.choices) checkChoiceDecisions(reader, element.choices, element.path.concat('choices'), element.id);
    if (element.code) CODE_REFERENCE_FIELDS.forEach((field) => referenceEntries(fields[field], element.path.concat(field))
      .forEach((entry) => checkCodeTarget(reader, element, field, entry)));
  }

  /** People and systems use top-level groups; containers and components use their parent's groups (spec §4.4). */
  function checkGroupReference(reader, element) {
    if (element.group === null) return;
    const scopeId = element.type === 'person' || element.type === 'system' ? null : element.parentId;
    const scope = new Map([...reader.model.groups.values()].filter((group) => group.scopeId === scopeId).map((group) => [group.id, group]));
    const label = scopeId === null ? 'top-level group' : `group in ${elementLabel(reader.model.elements.get(scopeId))}`;
    resolves(reader, scope, element.group, element.path.concat('group'), label, { element: element.id });
  }

  function checkResponsibilityReferences(reader, responsibility, item) {
    const element = responsibility.ownerId;
    referenceEntries(fieldOf(item, 'refines'), responsibility.path.concat('refines'))
      .forEach((entry) => checkRefinement(reader, responsibility, entry));
    referenceEntries(fieldOf(item, 'requirements'), responsibility.path.concat('requirements'))
      .forEach(({ id, path }) => resolves(reader, reader.model.requirements, id, path, 'requirement', { element }));
  }

  /** A responsibility refines one owned by an element that contains its owner (spec §4.5). */
  function checkRefinement(reader, responsibility, { id, path }) {
    const { model, context } = reader;
    const element = responsibility.ownerId;
    if (!resolves(reader, model.responsibilityById, id, path, 'responsibility', { element })) return;
    const refinedOwnerId = model.responsibilityById.get(id).ownerId;
    if (isAncestor(model, refinedOwnerId, element)) return;
    report(context, 'model/refines-not-ancestor', `${code(id)} belongs to ${elementLabel(model.elements.get(refinedOwnerId))}, ` +
      `which does not contain ${code(element)}; a responsibility can only refine one of an enclosing element`, path, { element });
  }

  /**
   * `realizes` names responsibilities of the interface's provider or of its parts (spec §4.11, J12). Whether a part's
   * responsibility refines one of the provider's is an interface rule (`interface/realizes-internal`), not a model error.
   */
  function checkRealizedResponsibilities(reader, data) {
    reader.model.interfaces.forEach((declared) => declared.operations.forEach((operation) => {
      const path = operation.path.concat('realizes');
      referenceEntries(valueAt(data, path), path).forEach((entry) => checkRealized(reader, declared.providerId, entry));
    }));
  }

  function checkRealized(reader, providerId, { id, path }) {
    const { model } = reader;
    if (!resolves(reader, model.responsibilityById, id, path, 'responsibility', { element: providerId })) return;
    const ownerId = model.responsibilityById.get(id).ownerId;
    if (isSameOrInside(model, ownerId, providerId)) return;
    report(reader.context, 'model/realizes-owner', `${code(id)} belongs to ${elementLabel(model.elements.get(ownerId))}, ` +
      `which is neither ${code(providerId)} nor a part of it; an operation realizes a responsibility of the element ` +
      'that provides its interface', path, { element: providerId });
  }

  /** `decision` fields in choices name entries of `decisions:` (spec §4.7). */
  function checkChoiceDecisions(reader, choices, path, element) {
    const checkDecision = (id, at) => id !== null && resolves(reader, reader.model.decisions, id, at, 'decision', { element });
    if (choices.technology) checkDecision(choices.technology.decision, path.concat('technology', 'decision'));
    choices.patterns.forEach((pattern, index) => checkDecision(pattern.decision, path.concat('patterns', index, 'decision')));
  }

  function checkCodeTarget(reader, element, field, { id, path }) {
    const target = elementReference(reader, id, path, { element: element.id });
    if (!target || target.type === 'code') return;
    const verb = field === 'extends' ? 'extend' : 'implement';
    report(reader.context, 'model/wrong-type-reference', `${code(element.id)} cannot ${verb} the ${elementLabel(target)}; ` +
      `${code(field)} names another code element`, path, { element: element.id });
  }

  // ---- Requirements, groups, responsibilities, decisions -------------------------------------

  function readRequirements(reader, value) {
    return readIdMap(reader, value, ['requirements'], (id, item, path) => {
      if (typeof item === 'string') return { id, text: item, kind: null, path };
      const fields = entryFields(reader, item, path, REQUIREMENT_KEYS, 'a requirement');
      return {
        id,
        text: readText(reader.context, fields.text, path.concat('text')),
        kind: readEnum(reader.context, fields.kind, path.concat('kind'), schema.REQUIREMENT_KINDS, 'requirement kind'),
        path,
      };
    });
  }

  function groupKey(scopeId, id) {
    return `${scopeId || ''}/${id}`;
  }

  /** Top-level groups (scope null) and the groups systems and containers define for their children (spec §4.8). */
  function readGroups(reader, topLevel, elementFieldsById) {
    const groups = new Map();
    const addScope = (value, path, scopeId) => {
      readIdMap(reader, value, path, (id, item, groupPath) => {
        const fields = entryFields(reader, item, groupPath, GROUP_KEYS, 'a group', scopeId);
        const text = (key) => readText(reader.context, fields[key], groupPath.concat(key), scopeId);
        return { id, scopeId, name: text('name') || id, description: text('description'), path: groupPath };
      }).forEach((group) => groups.set(groupKey(scopeId, group.id), group));
    };
    addScope(topLevel, ['groups'], null);
    reader.model.elements.forEach((element) => {
      if (schema.FIELDS[element.type].includes('groups')) {
        addScope(elementFieldsById.get(element.id).groups, element.path.concat('groups'), element.id);
      }
    });
    return groups;
  }

  /** Responsibility ids share one namespace across the model; the first declaration keeps a duplicated id. */
  function indexResponsibilities(reader) {
    const byId = new Map();
    reader.model.elements.forEach((element) => element.responsibilities.forEach((responsibility) => {
      if (responsibility.id === null) return;
      const path = responsibility.path.concat('id');
      checkIdFormat(reader.context, responsibility.id, path, { part: 'value', element: element.id });
      const first = byId.get(responsibility.id);
      if (first) {
        report(reader.context, 'model/duplicate-id', `The responsibility id ${code(responsibility.id)} is already used by a ` +
          `responsibility of ${elementLabel(reader.model.elements.get(first.ownerId))}`, path, { element: element.id });
        return;
      }
      byId.set(responsibility.id, responsibility);
    }));
    return byId;
  }

  function readDecisions(reader, value) {
    return readIdMap(reader, value, ['decisions'], (id, item, path) => {
      const { context } = reader;
      const fields = entryFields(reader, item, path, DECISION_KEYS, 'a decision');
      const text = (key) => readText(context, fields[key], path.concat(key));
      const list = (key) => readOneOrMany(context, fields[key], path.concat(key));
      return {
        id,
        title: text('title'),
        status: readEnum(context, fields.status, path.concat('status'), schema.DECISION_STATUSES, 'decision status'),
        context: text('context'),
        decision: text('decision'),
        alternatives: readTextList(context, fields.alternatives, path.concat('alternatives')),
        consequences: text('consequences'),
        affects: list('affects'),
        supersedes: list('supersedes'),
        date: text('date'),
        path,
      };
    });
  }

  /** `affects` names elements and `supersedes` names other decisions. */
  function checkDecisionReferences(reader, decisionsData) {
    reader.model.decisions.forEach((decision) => {
      const fields = fieldOf(decisionsData, decision.id);
      referenceEntries(fieldOf(fields, 'affects'), decision.path.concat('affects'))
        .forEach(({ id, path }) => elementReference(reader, id, path));
      referenceEntries(fieldOf(fields, 'supersedes'), decision.path.concat('supersedes'))
        .forEach(({ id, path }) => resolves(reader, reader.model.decisions, id, path, 'decision'));
    });
  }

  // ---- Relationships -------------------------------------------------------------------------

  /** Relationships from every element's collaborators, in document order (spec §4.6); broken ones are left out. */
  function readRelationships(reader, elementFieldsById) {
    const relationships = [];
    const countByPair = new Map();
    reader.model.elements.forEach((source) => {
      const path = source.path.concat('collaborators');
      for (const [targetId, value, targetPath] of collaboratorTargets(reader, elementFieldsById.get(source.id).collaborators, path, source.id)) {
        if (!isValidCollaboration(reader, source, targetId, targetPath)) continue;
        for (const [item, itemPath] of collaboratorItems(value, targetPath)) {
          const collaboration = readCollaboration(reader, item, itemPath, source.id);
          if (!collaboration) continue;
          const pair = `${source.id}->${targetId}`;
          const count = (countByPair.get(pair) || 0) + 1;
          countByPair.set(pair, count);
          const relationship = Object.assign({ id: count === 1 ? pair : `${pair}#${count}`, sourceId: source.id, targetId },
            collaboration, { path: itemPath, index: relationships.length });
          checkRelationshipReferences(reader, relationship);
          relationships.push(relationship);
        }
      }
    });
    return relationships;
  }

  /** The target exists and is neither the source itself nor nested with it (spec §7.2 `model/containment-link`). */
  function isValidCollaboration(reader, source, targetId, path) {
    const { model } = reader;
    if (!elementReference(reader, targetId, path, { part: 'key', element: source.id })) return false;
    const problem = containmentProblem(model, source.id, targetId);
    if (!problem) return true;
    report(reader.context, 'model/containment-link', `${code(source.id)} cannot collaborate with ${problem}; ` +
      'relationships connect elements that do not contain each other', path, { part: 'key', element: source.id });
    return false;
  }

  function containmentProblem(model, sourceId, targetId) {
    if (sourceId === targetId) return 'itself';
    if (isAncestor(model, targetId, sourceId)) return `${code(targetId)}, which contains it`;
    if (isAncestor(model, sourceId, targetId)) return `${code(targetId)}, which it contains`;
    return null;
  }

  /** One relationship's fields from a description, a map, or an empty value; null when the shape is wrong (reported). */
  function readCollaboration(reader, item, path, element) {
    const { context } = reader;
    const fields = { description: null, technology: null, connector: 'call', responsibility: null, uses: [], choices: null };
    if (typeof item === 'string') fields.description = item;
    if (item == null || typeof item === 'string') return withAsync(fields);
    if (!isMap(item)) {
      report(context, 'schema/type', 'A collaborator is a description, a map with description and technology, or a list of these',
        path, { element });
      return null;
    }
    checkKeys(context, item, path, COLLABORATOR_KEYS, 'in a collaborator', { element });
    const text = (key) => readText(context, item[key], path.concat(key), element);
    return withAsync({
      description: text('description'),
      technology: text('technology'),
      connector: readEnum(context, item.connector, path.concat('connector'), schema.CONNECTORS, 'connector', element) || 'call',
      responsibility: text('responsibility'),
      uses: readReferences(context, item.uses, path.concat('uses'), element)
        .map((entry) => parseUsesEntry(context, entry.id, entry.path, element))
        .filter((entry) => entry !== null),
      choices: readChoices(context, item.choices, path.concat('choices'), element),
    });
  }

  function withAsync(fields) {
    return Object.assign(fields, { async: schema.ASYNC_CONNECTORS.includes(fields.connector) });
  }

  function checkRelationshipReferences(reader, relationship) {
    if (relationship.choices) checkChoiceDecisions(reader, relationship.choices, relationship.path.concat('choices'), relationship.sourceId);
    if (relationship.responsibility !== null) checkRequestedResponsibility(reader, relationship);
  }

  /**
   * A collaborator's `responsibility` is help that the target, a part of it, or an element containing the target
   * outside the source's chain provides (spec §4.6).
   */
  function checkRequestedResponsibility(reader, relationship) {
    const { model } = reader;
    const { responsibility: id, targetId, sourceId: element } = relationship;
    const path = relationship.path.concat('responsibility');
    if (!resolves(reader, model.responsibilityById, id, path, 'responsibility', { element })) return;
    const ownerId = model.responsibilityById.get(id).ownerId;
    if (servesRequest(model, ownerId, element, targetId)) return;
    report(reader.context, 'model/responsibility-owner', `${code(id)} belongs to ${elementLabel(model.elements.get(ownerId))}, ` +
      `which is neither ${code(targetId)}, a part of it, nor an element that contains ${code(targetId)} but not ${code(element)}; ` +
      'a collaborator asks its target for help the target provides', path, { element });
  }

  /**
   * Resolves each relationship's `uses` entries once every relationship is known (a broker peer depends on another
   * relationship, J7) and sets `requests`. Unknown and disallowed entries are reported and left out.
   */
  function resolveRelationshipUses(reader) {
    const { model } = reader;
    model.relationships.forEach((relationship) => {
      relationship.uses = relationship.uses.flatMap((entry) => {
        const declared = usedInterface(reader, entry, relationship.sourceId);
        if (!declared) return [];
        const kind = useKind(model, relationship.sourceId, relationship.targetId, declared.id);
        if (kind === null) {
          reportInterfaceProvider(reader, relationship, declared, entry);
          return [];
        }
        return [Object.assign({}, entry, { interfaceId: declared.id, kind, inherited: false })];
      });
      relationship.requests = requestedResponsibilities(model, relationship);
    });
  }

  function reportInterfaceProvider(reader, relationship, declared, entry) {
    const { sourceId, targetId } = relationship;
    const provider = reader.model.elements.get(declared.providerId);
    report(reader.context, 'model/interface-provider', `${code(entry.text)} names ${declared.name}, an interface of ` +
      `${provider.name}; the relationship from ${code(sourceId)} to ${code(targetId)} can use an interface of ${code(targetId)}, ` +
      `of a part of it, or of an element that contains ${code(targetId)} but not ${code(sourceId)}`, entry.path, {
      element: sourceId,
      hint: 'An element may also use its own event or stream interface to reach a subscriber; a relationship to a queue ' +
        'or topic may use an interface of an element that has its own relationship to that queue or topic.',
    });
  }

  /** The relationship's `responsibility` and every responsibility realized by an operation it uses (spec §4.6), once each. */
  function requestedResponsibilities(model, relationship) {
    const requested = relationship.responsibility === null ? [] : [relationship.responsibility];
    relationship.uses.forEach((use) => {
      model.interfaces.get(use.interfaceId).operations
        .filter((operation) => use.operationId === null || operation.id === use.operationId)
        .forEach((operation) => requested.push(...operation.realizes));
    });
    return [...new Set(requested)];
  }

  // ---- Scenarios -----------------------------------------------------------------------------

  function readScenarios(reader, value) {
    return readIdMap(reader, value, ['scenarios'], (id, item, path) => {
      const fields = entryFields(reader, item, path, SCENARIO_KEYS, 'a scenario');
      const text = (key) => readText(reader.context, fields[key], path.concat(key));
      return { id, title: text('title'), description: text('description'), steps: readSteps(reader, fields.steps, path.concat('steps')), path };
    });
  }

  function readSteps(reader, value, path) {
    return readList(reader.context, value, path)
      .map((item, index) => readStep(reader, item, path.concat(index)))
      .filter((step) => step !== null);
  }

  /** A step is `"a -> b": description`, a map with from and to, or a fragment (spec §4.8); null when malformed. */
  function readStep(reader, item, path) {
    if (!isMap(item)) {
      report(reader.context, 'schema/type', 'A step is "a -> b": description, a map with from and to, or a fragment such as alt', path);
      return null;
    }
    const keys = Object.keys(item);
    if (keys.length === 1 && schema.FRAGMENTS.includes(keys[0])) return readFragment(reader, keys[0], item[keys[0]], path);
    const ends = keys.length === 1 ? schema.parseStepShorthand(keys[0]) : null;
    if (ends) return readShorthandStep(reader, ends, keys[0], item[keys[0]], path);
    return readMessageStep(reader, item, path);
  }

  function messageStep(fields, path) {
    return Object.assign({ kind: 'message', from: null, to: null, description: null, technology: null, connector: null,
      responsibility: null, uses: null }, fields, { path });
  }

  function readShorthandStep(reader, { from, to }, key, value, path) {
    const keyPath = path.concat(key);
    [from, to].forEach((id) => elementReference(reader, id, keyPath, { part: 'key' }));
    return messageStep({ from, to, description: readText(reader.context, value, keyPath) }, path);
  }

  function readMessageStep(reader, item, path) {
    const { context } = reader;
    checkKeys(context, item, path, STEP_KEYS, 'in a step');
    const text = (key) => readText(context, item[key], path.concat(key));
    const step = messageStep({
      from: text('from'),
      to: text('to'),
      description: text('description'),
      technology: text('technology'),
      connector: readEnum(context, item.connector, path.concat('connector'), schema.CONNECTORS, 'connector'),
      responsibility: text('responsibility'),
    }, path);
    if (step.from === null || step.to === null) report(context, 'schema/type', 'A message step needs both from and to', path);
    ['from', 'to'].forEach((key) => step[key] !== null && elementReference(reader, step[key], path.concat(key)));
    if (step.responsibility !== null) {
      resolves(reader, reader.model.responsibilityById, step.responsibility, path.concat('responsibility'), 'responsibility');
    }
    const usesText = text('uses');
    if (usesText !== null) step.uses = readStepUse(reader, usesText, path.concat('uses'), step.from);
    if (step.uses !== null) checkStepUse(reader, step);
    return step;
  }

  /** A step's own `uses` names one operation (spec §4.8); null when it is malformed or unknown (reported). */
  function readStepUse(reader, text, path, element) {
    const entry = parseUsesEntry(reader.context, text, path, element);
    if (entry === null) return null;
    if (entry.operationId === null) {
      report(reader.context, 'schema/value', `A step uses one operation; write ${code(text + '.<operation-id>')}`, path, { element });
      return null;
    }
    const declared = usedInterface(reader, entry, element);
    return declared && Object.assign(entry, { interfaceId: declared.id });
  }

  /**
   * A step's `uses` must be among the uses of the relationships it follows (spec §4.8): those from `from` to `to`, or,
   * for a reply, those from `to` to `from`. A step that follows no relationship is reported by the checks instead.
   */
  function checkStepUse(reader, step) {
    const { model } = reader;
    if (!model.elements.has(step.from) || !model.elements.has(step.to)) return;
    const forward = relationshipsBetween(model, step.from, step.to);
    const backing = forward.length > 0 ? forward : relationshipsBetween(model, step.to, step.from);
    if (backing.length === 0) return;
    const { interfaceId, operationId, text, path } = step.uses;
    const covers = (use) => use.interfaceId === interfaceId && (use.operationId === null || use.operationId === operationId);
    if (backing.some((relationship) => relationship.uses.some(covers))) return;
    const [source, target] = [model.elements.get(step.from), model.elements.get(step.to)];
    report(reader.context, 'xlevel/scenario-step', `The step from ${source.name} to ${target.name} uses ${code(text)}, but the ` +
      `relationship it follows does not; a step can only use what its relationship uses`, path, {
      element: step.from, hint: `Add ${code(text)} to the relationship's uses, or name an operation the relationship uses.`,
    });
  }

  /** Relationships from `fromId` or one of its parts to `toId` or one of its parts. */
  function relationshipsBetween(model, fromId, toId) {
    return model.relationships.filter((relationship) => isSameOrInside(model, relationship.sourceId, fromId)
      && isSameOrInside(model, relationship.targetId, toId));
  }

  /** `alt` and `par` hold a list of branches; `opt`, `loop`, and `break` hold one branch. */
  function readFragment(reader, operator, value, path) {
    const fragmentPath = path.concat(operator);
    const branches = MULTI_BRANCH_FRAGMENTS.includes(operator)
      ? readList(reader.context, value, fragmentPath).map((branch, index) => readBranch(reader, branch, fragmentPath.concat(index)))
      : [readBranch(reader, value, fragmentPath)];
    return { kind: 'fragment', operator, branches, path };
  }

  function readBranch(reader, value, path) {
    const fields = entryFields(reader, value, path, BRANCH_KEYS, 'a fragment branch');
    return { when: readText(reader.context, fields.when, path.concat('when')), steps: readSteps(reader, fields.steps, path.concat('steps')) };
  }

  // ---- Deployment ----------------------------------------------------------------------------

  function readEnvironments(reader, value) {
    return readIdMap(reader, value, ['deployment'], (id, item, path) => {
      const fields = entryFields(reader, item, path, ENVIRONMENT_KEYS, 'a deployment environment');
      const text = (key) => readText(reader.context, fields[key], path.concat(key));
      const environment = { id, name: text('name') || id, description: text('description'), nodes: new Map(), rootNodeIds: [], path };
      const walker = { reader, environment, fieldsById: new Map() };
      environment.rootNodeIds = readNodeMap(walker, fields.nodes, path.concat('nodes'), null);
      environment.nodes.forEach((node) => { node.relationships = readNodeRelationships(walker, node); });
      return environment;
    });
  }

  /** Reads a map of deployment nodes; returns the ids it added, in document order. */
  function readNodeMap(walker, value, path, parentId) {
    if (value == null) return [];
    if (!isMap(value)) {
      report(walker.reader.context, 'schema/type', `${code('nodes')} must be a map from id to deployment node`, path);
      return [];
    }
    return Object.entries(value).filter(([id, item]) => readNode(walker, id, item, path.concat(id), parentId)).map(([id]) => id);
  }

  /** Adds one node and its nested nodes; false when its id is already taken in this environment. */
  function readNode(walker, id, item, path, parentId) {
    const { reader, environment } = walker;
    const { context } = reader;
    const first = environment.nodes.get(id);
    if (first) {
      report(context, 'model/duplicate-id', `The node id ${code(id)} is already used at ${first.path.join('.')}; ` +
        `node ids are unique within the environment ${code(environment.id)}`, path, { part: 'key' });
      return false;
    }
    checkIdFormat(context, id, path);
    const fields = entryFields(reader, item, path, NODE_KEYS, 'a deployment node');
    const text = (key) => readText(context, fields[key], path.concat(key));
    const kind = readEnum(context, fields.kind, path.concat('kind'), schema.NODE_KINDS, 'node kind');
    if (kind === 'infrastructure') checkInfrastructureLeaf(context, fields, path, id);
    const node = {
      id,
      name: text('name') || id,
      description: text('description'),
      kind,
      technology: text('technology'),
      instances: readInstances(context, fields.instances, path.concat('instances')),
      hosts: readHosts(reader, fields.hosts, path.concat('hosts')),
      childIds: [],
      parentId,
      relationships: [],
      tags: readTextList(context, fields.tags, path.concat('tags')),
      path,
    };
    environment.nodes.set(id, node);
    walker.fieldsById.set(id, fields);
    node.childIds = readNodeMap(walker, fields.nodes, path.concat('nodes'), id);
    return true;
  }

  function checkInfrastructureLeaf(context, fields, path, id) {
    ['hosts', 'nodes'].filter((key) => key in fields).forEach((key) => {
      report(context, 'model/infrastructure-leaf', `The infrastructure node ${code(id)} cannot have ${code(key)}; ` +
        'infrastructure such as a load balancer or firewall is a leaf, so use an environment or device node instead',
      path.concat(key), { part: 'key' });
    });
  }

  /** Hosted containers and software systems; other references are reported and left out (spec §4.8). */
  function readHosts(reader, value, path) {
    return readReferences(reader.context, value, path)
      .filter((entry) => isDeployable(reader, entry))
      .map((entry) => entry.id);
  }

  function isDeployable(reader, { id, path }) {
    const target = elementReference(reader, id, path);
    if (!target) return false;
    if (DEPLOYABLE_TYPES.includes(target.type)) return true;
    report(reader.context, 'model/wrong-type-reference', deploymentAdvice(reader.model, target), path, { element: id });
    return false;
  }

  function deploymentAdvice(model, element) {
    if (element.type === 'person') return `${code(element.id)} is a person; deployment nodes host containers and software systems`;
    let container = element;
    while (container && container.type !== 'container') container = model.elements.get(container.parentId);
    const label = TYPE_LABELS[element.type];
    return `${code(element.id)} is a ${label}, and a ${label} is not separately deployable; host its container ${code(container.id)}`;
  }

  /** Node collaborators: links to nodes of the same environment. */
  function readNodeRelationships(walker, node) {
    const { reader, environment } = walker;
    const relationships = [];
    const path = node.path.concat('collaborators');
    for (const [targetId, value, targetPath] of collaboratorTargets(reader, walker.fieldsById.get(node.id).collaborators, path, null)) {
      const label = `node in the environment ${code(environment.id)} named`;
      if (!resolves(reader, environment.nodes, targetId, targetPath, label, { part: 'key' })) continue;
      for (const [item, itemPath] of collaboratorItems(value, targetPath)) {
        const link = readNodeLink(reader, item, itemPath);
        if (link) relationships.push(Object.assign({ targetId }, link, { path: itemPath }));
      }
    }
    return relationships;
  }

  function readNodeLink(reader, item, path) {
    if (item == null || typeof item === 'string') return { description: item == null ? null : item, technology: null };
    if (!isMap(item)) {
      report(reader.context, 'schema/type', 'A node collaborator is a description or a map with description and technology', path);
      return null;
    }
    checkKeys(reader.context, item, path, NODE_COLLABORATOR_KEYS, 'in a node collaborator',
      { misplaced: (key) => key === 'uses' && NODE_USES_MESSAGE });
    const text = (key) => readText(reader.context, item[key], path.concat(key));
    return { description: text('description'), technology: text('technology') };
  }

  // ---- Views, layout, and check suppressions -------------------------------------------------

  function readViews(reader, value) {
    return readIdMap(reader, value, ['views'], (id, item, path) => {
      if (!schema.isReservedViewId(id)) return readView(reader, id, item, path);
      report(reader.context, 'schema/value', `${code(id)} is the name of a built-in view; give the custom view another id`,
        path, { part: 'key' });
      return null;
    });
  }

  function readView(reader, id, item, path) {
    const { context } = reader;
    const fields = viewFields(reader, item, path);
    const at = (key) => path.concat(key);
    const text = (key) => readText(context, fields[key], at(key));
    const elementIds = (key) => readReferences(context, fields[key], at(key))
      .filter((entry) => elementReference(reader, entry.id, entry.path))
      .map((entry) => entry.id);
    return {
      id,
      view: text('view'),
      title: text('title'),
      description: text('description'),
      include: elementIds('include'),
      exclude: elementIds('exclude'),
      direction: readEnum(context, fields.direction, at('direction'), DIRECTIONS, 'direction') || 'down',
      annotations: readEnumList(context, fields.annotations, at('annotations'), ANNOTATIONS, 'annotation'),
      showTitle: readBoolean(context, fields.show_title, at('show_title'), null, true),
      derived: readBoolean(context, fields.derived, at('derived'), null, true),
      path,
    };
  }

  /**
   * The fields of a custom view that its base view accepts: a view over `interfaces of` or `interface` takes only
   * some of the view fields (spec §4.8); the others are misplaced (reported) and not read.
   */
  function viewFields(reader, item, path) {
    const selector = typeof fieldOf(item, 'view') === 'string' ? schema.parseSelector(item.view) : null;
    const allowed = (selector && schema.INTERFACE_VIEW_FIELDS[selector.type]) || schema.VIEW_FIELDS;
    const misplaced = (key) => schema.VIEW_FIELDS.includes(key) &&
      `${code(key)} is not allowed on a view based on ${code(selector.canonical)}; such a view accepts ` +
      listText(allowed.filter((field) => field !== 'view'));
    const fields = entryFields(reader, item, path, allowed, 'a view', null, misplaced);
    return Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key)));
  }

  /**
   * Editor-managed layout keyed by canonical view key (spec §4.8): for a view drawn in C4 notation, positions keyed by
   * element id; for a UML-notation view, its named parts (UML-view editing spec §4.2). A custom view's key takes the
   * form of the view it is based on, so the views are read first.
   */
  function readLayout(reader, value) {
    const layout = new Map();
    const { context, model } = reader;
    if (value == null) return layout;
    if (!isMap(value)) {
      report(context, 'schema/type', `${code('layout')} must be a map from view to element positions`, ['layout']);
      return layout;
    }
    const customSelector = (viewId) => (model.views.has(viewId) ? model.views.get(viewId).view : null);
    for (const [key, entry] of Object.entries(value)) {
      const viewKey = schema.selectorKey(key);
      const path = ['layout', key];
      if (layout.has(viewKey)) {
        report(context, 'model/duplicate-id', `The layout already has positions for the view ${code(viewKey)}; merge the two entries`,
          path, { part: 'key' });
        continue;
      }
      const view = schema.layoutView(key, customSelector);
      const umlType = view && schema.UML_LAYOUT_PARTS[view.type] ? view.type : null;
      layout.set(viewKey, umlType ? readUmlLayout(context, entry, path, umlType) : readPositions(context, entry, path));
    }
    return layout;
  }

  const UML_VIEW_NAMES = { code: 'a code view', deployment: 'a deployment view', interfaces: 'an interfaces view', dynamic: 'a dynamic view' };

  /**
   * The layout entry of a UML-notation view as `{ positions: Map<id, [x, y]>, routes: [{ from, to, relation, points }],
   * lifelines: [id] }`, each part read only where the view type keeps it (UML-view editing spec §4.2).
   */
  function readUmlLayout(context, value, path, type) {
    const parts = schema.UML_LAYOUT_PARTS[type];
    const entry = { positions: new Map(), routes: [], lifelines: [] };
    if (value == null) return entry;
    const keeps = `The layout of ${UML_VIEW_NAMES[type]} holds ${listText(parts.map(code))}`;
    if (!isMap(value)) {
      report(context, 'schema/type', keeps, path);
      return entry;
    }
    if (isPinMap(value)) {
      report(context, 'schema/type', `${keeps}, not positions keyed by id`, path, { hint: pinMapHint(type, Object.keys(value)[0]) });
      return entry;
    }
    Object.keys(value).filter((key) => !parts.includes(key) && !isExtensionKey(key)).forEach((key) => {
      report(context, 'schema/unknown-key', withSuggestion(`Unknown key ${code(key)} in the layout of ${UML_VIEW_NAMES[type]}`, key, parts),
        path.concat(key), { part: 'key', hint: `${keeps}.` });
    });
    if (parts.includes('positions')) entry.positions = readPositions(context, value.positions, path.concat('positions'));
    if (parts.includes('routes')) entry.routes = readRoutes(context, value.routes, path.concat('routes'), schema.ROUTE_RELATIONS[type]);
    if (parts.includes('lifelines')) entry.lifelines = readTextList(context, value.lifelines, path.concat('lifelines'));
    return entry;
  }

  /** True for a map written as a C4 pin map: it has entries, and none of them is a layout part. */
  function isPinMap(value) {
    const keys = Object.keys(value).filter((key) => !isExtensionKey(key));
    return keys.length > 0 && !keys.some((key) => schema.LAYOUT_PART_ORDER.includes(key));
  }

  function pinMapHint(type, firstKey) {
    if (type === 'dynamic') return `A dynamic view keeps only the order of its lifelines: write ${code('lifelines: [a, b]')}.`;
    return `Put the positions under ${code('positions')}, as in ${code(`positions: {${firstKey}: [x, y]}`)}.`;
  }

  /** The routes of a layout entry; a malformed route is reported and left out. */
  function readRoutes(context, value, path, relations) {
    return readList(context, value, path).flatMap((item, index) => {
      const at = path.concat(index);
      if (!isMap(item)) {
        report(context, 'schema/type', `A route is a map of ${listText(schema.ROUTE_KEYS)}`, at);
        return [];
      }
      checkKeys(context, item, at, schema.ROUTE_KEYS, 'in a route');
      const missing = schema.ROUTE_KEYS.filter((key) => item[key] == null);
      if (missing.length > 0) {
        report(context, 'schema/type', `A route needs ${listText(missing.map(code))}`, at);
        return [];
      }
      const from = readText(context, item.from, at.concat('from'));
      const to = readText(context, item.to, at.concat('to'));
      const relation = readEnum(context, item.relation, at.concat('relation'), relations, 'route relation');
      const points = readRoutePoints(context, item.points, at.concat('points'));
      return from !== null && to !== null && relation !== null && points !== null ? [{ from, to, relation, points }] : [];
    });
  }

  /** The `[x, y]` points of a route, at least two; null when malformed (reported). */
  function readRoutePoints(context, value, path) {
    if (!Array.isArray(value) || value.length < 2) {
      report(context, 'schema/type', 'A route has at least two points, as in [[x, y], [x, y]]', path);
      return null;
    }
    const points = value.map((point, index) => readPoint(context, point, path.concat(index)));
    return points.every((point) => point !== null) ? points : null;
  }

  function readPositions(context, value, path) {
    const positions = new Map();
    if (value == null) return positions;
    if (!isMap(value)) {
      report(context, 'schema/type', 'A layout entry maps element ids to [x, y] positions', path);
      return positions;
    }
    for (const [id, point] of Object.entries(value)) {
      const position = readPoint(context, point, path.concat(id));
      if (position) positions.set(id, position);
    }
    return positions;
  }

  /** `checks.ignore` entries (spec §4.8); whether each is active is decided by the checks runner. */
  function readIgnores(reader, value) {
    const fields = entryFields(reader, value, ['checks'], CHECKS_KEYS, 'checks');
    const path = ['checks', 'ignore'];
    return readList(reader.context, fields.ignore, path).map((item, index) => {
      const entryPath = path.concat(index);
      const entry = entryFields(reader, item, entryPath, IGNORE_KEYS, 'an ignore entry');
      const text = (key) => readText(reader.context, entry[key], entryPath.concat(key));
      return { rule: text('rule'), element: text('element'), because: text('because'), path: entryPath };
    });
  }

  // ---- Typed values --------------------------------------------------------------------------

  function isMap(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** A text value; null when absent or empty, and when it is a collection (reported). */
  function readText(context, value, path, element = null) {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    report(context, 'schema/type', `${code(path[path.length - 1])} must be a text, not a ${Array.isArray(value) ? 'list' : 'map'}`,
      path, { element });
    return null;
  }

  function readList(context, value, path, element) {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    report(context, 'schema/type', `${code(path[path.length - 1])} must be a list`, path, { element });
    return [];
  }

  /** A list of texts; items that are not texts are reported and dropped. */
  function readTextList(context, value, path, element) {
    return readList(context, value, path, element)
      .map((item, index) => readText(context, item, path.concat(index), element))
      .filter((item) => item !== null);
  }

  /** One text or a list of texts (`refines: a` or `refines: [a, b]`), always as a list. */
  function readOneOrMany(context, value, path, element) {
    return readReferences(context, value, path, element).map((entry) => entry.id);
  }

  /** The texts of a one-or-many field as `{ id, path }` entries; items that are not texts are reported and dropped. */
  function readReferences(context, value, path, element) {
    if (typeof value === 'string') return [{ id: value, path }];
    return readList(context, value, path, element)
      .map((item, index) => ({ id: readText(context, item, path.concat(index), element), path: path.concat(index) }))
      .filter((entry) => entry.id !== null);
  }

  /** Like `readReferences`, without reporting: for fields whose shape was already checked when they were read. */
  function referenceEntries(value, path) {
    if (typeof value === 'string') return [{ id: value, path }];
    if (!Array.isArray(value)) return [];
    return value.map((id, index) => ({ id, path: path.concat(index) })).filter((entry) => typeof entry.id === 'string');
  }

  /** The value of `key` in `value` when `value` is a map; undefined otherwise. */
  function fieldOf(value, key) {
    return isMap(value) ? value[key] : undefined;
  }

  /** The parsed value at `path` (map keys and list indexes); undefined when the path leaves the data. */
  function valueAt(data, path) {
    return path.reduce((value, key) => (Array.isArray(value) ? value[key] : fieldOf(value, key)), data);
  }

  function readInstances(context, value, path) {
    if (value == null) return 1;
    if (typeof value === 'string' && WHOLE_NUMBER.test(value) && Number(value) >= 1) return Number(value);
    report(context, 'schema/type', `${code('instances')} must be a whole number of at least 1`, path);
    return 1;
  }

  /** A layout position `[x, y]` as two numbers; null when malformed (reported). */
  function readPoint(context, value, path) {
    const isNumber = (item) => typeof item === 'string' && DECIMAL_NUMBER.test(item);
    if (Array.isArray(value) && value.length === 2 && value.every(isNumber)) return value.map(Number);
    report(context, 'schema/type', 'A layout position is a list of two numbers, [x, y]', path);
    return null;
  }

  function readBoolean(context, value, path, element, fallback) {
    if (value == null) return fallback;
    if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(BOOLEAN_TEXT, value)) return BOOLEAN_TEXT[value];
    report(context, 'schema/type', `${code(path[path.length - 1])} must be true or false`, path, { element });
    return fallback;
  }

  /** A text from `allowed`; null when absent or not allowed (reported with a suggestion). */
  function readEnum(context, value, path, allowed, label, element = null) {
    const text = readText(context, value, path, element);
    if (text === null || allowed.includes(text)) return text;
    const suggestion = schema.suggest(text, allowed);
    const advice = suggestion ? `did you mean ${code(suggestion)}?` : `use one of ${allowed.join(', ')}`;
    report(context, 'schema/value', `Unknown ${label} ${code(text)}; ${advice}`, path, { element });
    return null;
  }

  function readEnumList(context, value, path, allowed, label, element) {
    return readList(context, value, path, element)
      .map((item, index) => readEnum(context, item, path.concat(index), allowed, label, element))
      .filter((item) => item !== null);
  }

  return { normalize, useKind };
});
