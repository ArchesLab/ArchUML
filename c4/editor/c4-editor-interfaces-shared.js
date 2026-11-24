(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () { return require('../c4-schema.js'); }, function () {
      return { scaffolds: require('./c4-editor-scaffolds.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.interfacesShared = factory(root.ArchUMLC4, function () { return (root.ArchUMLC4Parts || {}).schema; },
      function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, coreSchema, editorParts) {
  'use strict';

  // The DOM-free helpers of the interface forms (c4-editor-interfaces.js and its units; spec §9.5): which view holds a
  // diagnostic, example flow text, Realizes groups, Uses groups, the paths a rename rewrites, and the texts and keys
  // the forms share. c4-editor-interfaces.js exports the ones tests and other parts use.

  // The style select's options: their one-line definitions belong to the scaffolds (spec §9.3 "Style"), which own
  // every student-facing definition; `word` names a style in an interface row ("REST", "style not chosen yet").
  function styleChoices() {
    return editorParts().scaffolds.styleChoices().map((choice) => Object.assign({}, choice, { word: choice.name || 'style not chosen yet' }));
  }
  const VIEWS = Object.freeze([
    { name: 'syntactic', label: 'Syntactic view' },
    { name: 'semantic', label: 'Semantic view' },
  ]);
  // Keys of the semantic view (spec §4.11): under an operation, a field, or the interface itself.
  const SEMANTIC_KEYS = new Set(['purpose', 'side_effects', 'restrictions', 'errors', 'examples', 'realizes', 'meaning', 'unit',
    'format', 'example', 'vocabulary']);
  // Rules about something the semantic view describes, whose path names the operation or field as a whole.
  const SEMANTIC_RULES = new Set(['interface/no-purpose', 'interface/no-errors', 'interface/no-unit', 'interface/no-format',
    'interface/no-meaning', 'interface/no-example', 'interface/unrealized', 'interface/realizes-internal',
    'interface/example-mismatch', 'interface/conflicting-vocabulary', 'model/realizes-owner']);
  // The key a rule finds missing, so Problems › Show lands on the input that supplies it (spec §9.2).
  const MISSING_KEYS = {
    'interface/no-purpose': 'purpose', 'interface/no-errors': 'errors', 'interface/no-unit': 'unit',
    'interface/no-format': 'format', 'interface/no-meaning': 'meaning', 'interface/unrealized': 'realizes',
    'interface/no-example': 'examples',
  };
  const UNIT_RULES = ['interface/no-unit'];
  const FORMAT_RULES = ['interface/no-format'];
  const INLINE = '__inline';
  const PAYLOAD_PARTS = [{ part: 'input', label: 'Input' }, { part: 'output', label: 'Output' }];
  const KIND_WORDS = { know: 'KNOW', do: 'DO', decide: 'DECIDE' };
  const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const PLAIN_SCALAR = /^[A-Za-z_][A-Za-z0-9_ ./-]*$/;
  const RESERVED_SCALAR = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;
  const TEXT = {
    empty: (name) => `${name} offers no described interface yet. Describe one wherever a client crosses its boundary.`,
    shorthand: 'A shorthand list of syntax lines. Describe it fully to add purposes, errors, types, and meanings.',
    inlineNote: (part, type) => `The ${part} is the type ${type}; describe its fields under Types.`,
    inlinePending: (part, type) => (type ? `The ${part} stays ${type} until you add its first field below.`
      : `The ${part} is written when you add its first field below.`),
    noPayloadFields: 'No fields to give an example for yet.',
    privateTo: (owner) => `private to ${owner}`,
    definitions: 'Definitions:',
    keyLocked: (name, what) => `Locked: ${name} or a part of it is given by the task, so its ${what} cannot be changed here.`,
    referenceLocked: (name, what) => `Locked: the task gives a part of the design that names ${name}, so its ${what} cannot be changed here.`,
  };

  // ---- DOM-free helpers --------------------------------------------------------------------------------------

  function schema() {
    return coreSchema();
  }

  /** The interfaces `elementId` provides, in document order. */
  function interfacesOfElement(model, elementId) {
    return [...model.interfaces.values()].filter((declared) => declared.providerId === elementId);
  }

  /**
   * The key that names what the path under an interface describes: the operation's key (`purpose`, `input`), a
   * field's key (`unit`, `type`), or the interface's own key (`restrictions`, `vocabulary`); null for the interface,
   * an operation, a type, or a field as a whole.
   */
  function propertyKey(rest) {
    if (rest[0] === 'operations') {
      if (rest[2] === 'input' || rest[2] === 'output') return rest.length > 4 ? rest[4] : rest[3] === undefined ? rest[2] : null;
      return rest.length > 2 ? rest[2] : null;
    }
    if (rest[0] === 'types') return rest.length > 4 ? rest[4] : rest[2] === 'description' ? 'description' : null;
    return rest.length > 0 ? rest[0] : null;
  }

  /** 'syntactic' or 'semantic': the tab that holds the YAML `path` under `declared`; null for Basics. */
  function viewOfPath(declared, path, rule = null) {
    const rest = path.slice(declared.path.length);
    const key = propertyKey(rest);
    if ((key !== null && SEMANTIC_KEYS.has(key)) || (rule !== null && SEMANTIC_RULES.has(rule))) return 'semantic';
    return rest[0] === 'operations' || rest[0] === 'types' ? 'syntactic' : null;
  }

  function isAbout(declared, diagnostic) {
    return typeof diagnostic.interface === 'string' && diagnostic.interface.toLowerCase() === declared.id.toLowerCase();
  }

  /** "4 warnings", "1 error, 2 warnings", or '': the errors and warnings among `diagnostics`. */
  function problemCount(diagnostics) {
    return [['error', 'error', 'errors'], ['warning', 'warning', 'warnings']]
      .map(([severity, one, many]) => {
        const count = diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;
        return count === 0 ? null : `${count} ${count === 1 ? one : many}`;
      }).filter(Boolean).join(', ');
  }

  /** The diagnostics about `declared` that each tab holds: `{ syntactic: [...], semantic: [...] }`. */
  function diagnosticsByView(declared, diagnostics) {
    const byView = { syntactic: [], semantic: [] };
    diagnostics.filter((diagnostic) => isAbout(declared, diagnostic)).forEach((diagnostic) => {
      const view = viewOfPath(declared, diagnostic.path || [], diagnostic.rule);
      if (view) byView[view].push(diagnostic);
    });
    return byView;
  }

  /**
   * The input a Problems › Show request for `path` lands on: the path itself, or, when a diagnostic of a rule in
   * MISSING_KEYS points at that operation or field as a whole, the key it finds missing.
   */
  function focusPathFor(declared, diagnostics, path) {
    const found = diagnostics.find((diagnostic) => isAbout(declared, diagnostic) && MISSING_KEYS[diagnostic.rule]
      && samePath(diagnostic.path || [], path));
    return found ? path.concat(MISSING_KEYS[found.rule]) : path;
  }

  /** The value boxes of an example's `part`: the fields of an inline map or of a named type, else the whole value. */
  function payloadFields(declared, operation, part) {
    const use = operation[part];
    if (!use) return [];
    if (use.fields) return use.fields.map((field) => ({ name: field.name, type: field.type, typeText: field.typeText }));
    const type = use.type;
    if (type && !type.list && !type.primitive && declared.types.has(type.name)) {
      return declared.types.get(type.name).fields.map((field) => ({ name: field.name, type: field.type, typeText: field.typeText }));
    }
    return [{ name: null, type, typeText: use.typeText }];
  }

  /**
   * One YAML flow node from the values typed into the boxes of `fields` (`values` keyed by field name, '' for the
   * whole value), or null when every box is empty: `{status: enrolled, units_enrolled: 8}` (spec §9.5 examples).
   */
  function exampleText(fields, values) {
    const filled = fields.filter((field) => (values[field.name || ''] || '').trim() !== '');
    if (filled.length === 0) return null;
    if (fields.length === 1 && fields[0].name === null) return scalarText(values[''], fields[0].type);
    return `{${filled.map((field) => `${field.name}: ${scalarText(values[field.name], field.type)}`).join(', ')}}`;
  }

  /** A typed value as YAML flow text: numbers and booleans as typed, a list from commas, text quoted when YAML needs it. */
  function scalarText(text, type) {
    const value = text.trim();
    if (value.startsWith('{') || value.startsWith('[')) return value;
    if (type && type.list) {
      const item = Object.assign({}, type, { list: false });
      return `[${value.split(',').map((part) => part.trim()).filter(Boolean).map((part) => scalarText(part, item)).join(', ')}]`;
    }
    const name = type ? type.name : null;
    if (schema().NUMERIC_TYPES.includes(name) && NUMBER.test(value)) return value;
    if (name === 'boolean' && /^(?:true|false)$/.test(value)) return value;
    return PLAIN_SCALAR.test(value) && !RESERVED_SCALAR.test(value) ? value : JSON.stringify(value);
  }

  /**
   * The responsibilities an operation of `providerId`'s interface may realize (spec §4.11, §9.5): the provider's own,
   * then each descendant's, grouped by owner in document order. An item is `{ responsibility, index, isPrivate }`;
   * `isPrivate` marks a descendant's responsibility that refines none of the provider's, at any depth.
   */
  function realizesGroups(model, providerId) {
    const provider = model.elements.get(providerId);
    return [provider].concat(descendantsOf(model, provider))
      .filter((owner) => owner.responsibilities.length > 0)
      .map((owner) => ({
        owner,
        items: owner.responsibilities.map((responsibility, index) => ({
          responsibility, index, isPrivate: owner.id !== providerId && !refinesOneOf(model, responsibility, providerId, new Set()),
        })),
      }));
  }

  function descendantsOf(model, element) {
    return element.childIds.flatMap((id) => {
      const child = model.elements.get(id);
      return child ? [child].concat(descendantsOf(model, child)) : [];
    });
  }

  function refinesOneOf(model, responsibility, ownerId, seen) {
    return responsibility.refines.some((id) => {
      const refined = model.responsibilityById.get(id);
      if (!refined || seen.has(id)) return false;
      seen.add(id);
      return refined.ownerId === ownerId || refinesOneOf(model, refined, ownerId, seen);
    });
  }

  function responsibilityLabel(responsibility, owner) {
    const kind = KIND_WORDS[responsibility.kind];
    return `${kind ? `${kind} ` : ''}${responsibility.text} (${owner.name})`;
  }

  /** A field of the model as `setField` writes it, with `changes` applied; `required: true` is the default, so omitted. */
  function fieldData(field, changes = {}) {
    let values = null;
    if (field.values !== null) {
      values = field.valuesForm === 'map'
        ? Object.fromEntries(field.values.map((entry) => [entry.value, entry.meaning]))
        : field.values.map((entry) => entry.value);
    }
    return Object.assign({
      type: field.typeText, meaning: field.meaning, unit: field.unit, format: field.format,
      required: field.required === false ? false : null, values, constraints: field.constraints.length > 0 ? field.constraints : null,
      example: field.example,
    }, changes);
  }

  /** The interface a selection names, or null. */
  function interfaceIdOf(selection) {
    return selection && selection.interfaceId ? selection.interfaceId : null;
  }

  function samePath(a, b) {
    return a.length === b.length && a.every((segment, index) => String(segment) === String(b[index]));
  }

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  function moved(items, from, to) {
    const next = items.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  }

  function optionalText(value) {
    return value.trim() === '' ? null : value.trim();
  }

  function slug(key) {
    return String(key).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function onEnter(action) {
    return (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      action();
    };
  }

  // ---- Uses: DOM-free (spec §9.5 "Uses picker") ---------------------------------------------------------------

  // The order of the picker's groups by the core's `relation` (spec §9.5): where the request enters, the target's own,
  // remote interfaces inside the target, then the source's own interfaces it emits (directly or into a queue or
  // topic), then interfaces a queue or topic carries for another element.
  const USE_GROUPS = Object.freeze({
    entered: { rank: 0, perProvider: true, title: ({ provider }) => `Interfaces of ${provider} (where the request enters)` },
    target: { rank: 1, perProvider: false, title: ({ target }) => `Interfaces of ${target}` },
    'inside-target': { rank: 2, perProvider: true, title: ({ provider, target }) => `Interfaces of ${provider} (inside ${target})` },
    emitted: { rank: 3, perProvider: false, key: 'emits', title: ({ source }) => `Interfaces ${source} emits` },
    channel: { rank: 3, perProvider: false, key: 'emits', title: ({ source }) => `Interfaces ${source} emits` },
    'broker-peer': { rank: 4, perProvider: false, title: ({ target }) => `Interfaces carried by ${target}` },
  });

  /** The `uses` text of an entry `{ interfaceId, operationId }`: `<interface>` or `<interface>.<operation>`. */
  function useText({ interfaceId, operationId }) {
    return operationId ? `${interfaceId}.${operationId}` : interfaceId;
  }

  function sameUse(a, b) {
    return a.interfaceId === b.interfaceId && (a.operationId || null) === (b.operationId || null);
  }

  function wholeInterfaceLabel(name) {
    return `Some operations of ${name} (unspecified)`;
  }

  /**
   * The interfaces a relationship from `sourceId` to `targetId` may use, grouped for the picker (spec §9.5): groups in
   * the order of USE_GROUPS, each `{ key, title, interfaces: [{ interfaceId, name, entries }] }`. An interface's entries
   * are its operations, those realizing the requested `responsibility` first, then the whole interface (`operationId`
   * null); each entry is `{ interfaceId, operationId, label }`.
   */
  function usesGroups(design, { sourceId, targetId, responsibility = null }) {
    const { model } = design;
    const names = { source: model.elements.get(sourceId).name, target: model.elements.get(targetId).name };
    const groups = new Map();
    C4.usableInterfaces(design, { sourceId, targetId }).forEach((usable) => {
      const kind = USE_GROUPS[usable.relation];
      const key = `${kind.key || usable.relation}${kind.perProvider ? `:${usable.providerId}` : ''}`;
      if (!groups.has(key)) {
        groups.set(key, { key, rank: kind.rank, title: kind.title(Object.assign({ provider: usable.providerName }, names)), interfaces: [] });
      }
      groups.get(key).interfaces.push({ interfaceId: usable.interfaceId, name: usable.name, entries: useEntries(usable, responsibility) });
    });
    // Array sort is stable, so groups of one rank keep the core's document order.
    return [...groups.values()].sort((a, b) => a.rank - b.rank).map(({ key, title, interfaces }) => ({ key, title, interfaces }));
  }

  function useEntries(usable, responsibility) {
    const realizesRequested = (operation) => responsibility !== null && operation.realizes.includes(responsibility);
    const operations = usable.operations.filter(realizesRequested).concat(usable.operations.filter((operation) => !realizesRequested(operation)));
    return operations
      .map((operation) => ({ interfaceId: usable.interfaceId, operationId: operation.id, label: `${operation.id}: ${operation.syntax}` }))
      .concat({ interfaceId: usable.interfaceId, operationId: null, label: wholeInterfaceLabel(usable.name) });
  }

  /**
   * The uses after checking (`checked` true) or unchecking `entry` in `current` (both `{ interfaceId, operationId }`).
   * Within one interface the whole-interface entry and its operations are mutually exclusive (spec §9.5), so checking
   * one removes the others of that interface; every other entry keeps its place.
   */
  function toggleUse(current, entry, checked) {
    const kept = current.filter((use) => !sameUse(use, entry)
      && !(checked && use.interfaceId === entry.interfaceId && (use.operationId === null || entry.operationId === null)));
    return checked ? kept.concat({ interfaceId: entry.interfaceId, operationId: entry.operationId }) : kept;
  }

  /**
   * The union of the uses of `relationships` (a derived edge's sources), once each in first-seen order, each with a
   * read-only `label`: "Enrollment API: submit-plan (POST /v1/enrollments)" or the whole-interface label.
   */
  function derivedUses(model, relationships) {
    const seen = new Map();
    relationships.forEach((relationship) => relationship.uses.forEach((use) => {
      const text = useText(use);
      if (seen.has(text) || !model.interfaces.has(use.interfaceId)) return;
      const declared = model.interfaces.get(use.interfaceId);
      const operation = use.operationId ? declared.operations.find((candidate) => candidate.id === use.operationId) : null;
      const label = operation ? `${declared.name}: ${operation.id} (${operation.syntax})` : wholeInterfaceLabel(declared.name);
      seen.set(text, { interfaceId: use.interfaceId, operationId: use.operationId || null, label });
    }));
    return [...seen.values()];
  }

  // ---- Renames ----------------------------------------------------------------------------------------------

  /**
   * The YAML paths, apart from the renamed key itself, whose values the core rewrites when it renames (spec §4.10):
   * for `typeName`, the input, output, and field types of `declared` that name it (renameType); for `operationId`,
   * the `uses` entries that name that operation (renameOperation); otherwise, for the interface itself, every `uses`
   * entry that names it and every view or layout selector scoped to it (changeInterfaceId). `readAt(path)` reads the
   * authored YAML value at a path.
   */
  function renameRewritePaths(design, { declared, operationId = null, typeName = null }, readAt) {
    if (typeName !== null) return typeReferencePaths(declared, typeName);
    const uses = C4.interfaceDependentsOf(design, declared.id).map((dependent) => dependent.path)
      .filter((path) => operationId === null || namesOperation(readAt(path), operationId));
    return operationId === null ? uses.concat(selectorPaths(declared.id, readAt)) : uses;
  }

  function typeReferencePaths(declared, typeName) {
    const names = (type) => Boolean(type) && !type.invalid && type.name === typeName;
    // A field written as `name: Type` holds its type at its own path; a lock there also covers `<path>.type`.
    const fieldPaths = (fields) => fields.filter((entry) => names(entry.type)).map((entry) => entry.path.concat('type'));
    const paths = [];
    declared.operations.forEach((operation) => ['input', 'output'].forEach((part) => {
      const use = operation[part];
      if (use && use.fields) paths.push(...fieldPaths(use.fields));
      else if (use && names(use.type)) paths.push(operation.path.concat(part));
    }));
    declared.types.forEach((type) => paths.push(...fieldPaths(type.fields)));
    return paths;
  }

  function namesOperation(text, operationId) {
    if (typeof text !== 'string') return false;
    const ref = schema().parseUsesRef(text);
    return !ref.error && ref.operationId === operationId;
  }

  /** The `view` selectors and `layout` keys that scope to the interface `interfaceId` (`interface <id> of <element>`). */
  function selectorPaths(interfaceId, readAt) {
    const id = interfaceId.toLowerCase();
    const scoped = (selector) => typeof selector === 'string' &&
      schema().withSelectorScope(selector, (element) => element, (named) => (named.toLowerCase() === id ? `${named}-renamed` : named)) !== selector;
    const views = readAt(['views']);
    const layout = readAt(['layout']);
    return [scoped(readAt(['view'])) ? ['view'] : null]
      .concat(isPlainMap(views) ? Object.keys(views).map((key) => (scoped(fieldOfMap(views[key], 'view')) ? ['views', key, 'view'] : null)) : [])
      .concat(isPlainMap(layout) ? Object.keys(layout).map((key) => (scoped(key) ? ['layout', key] : null)) : [])
      .filter(Boolean);
  }

  function isPlainMap(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function fieldOfMap(value, key) {
    return isPlainMap(value) ? value[key] : undefined;
  }

  return {
    styleChoices,
    VIEWS,
    UNIT_RULES,
    FORMAT_RULES,
    INLINE,
    PAYLOAD_PARTS,
    TEXT,
    schema,
    interfacesOfElement,
    viewOfPath,
    isAbout,
    problemCount,
    diagnosticsByView,
    focusPathFor,
    payloadFields,
    exampleText,
    realizesGroups,
    responsibilityLabel,
    fieldData,
    interfaceIdOf,
    samePath,
    plural,
    moved,
    optionalText,
    slug,
    onEnter,
    useText,
    sameUse,
    usesGroups,
    toggleUse,
    derivedUses,
    renameRewritePaths,
  };
});
