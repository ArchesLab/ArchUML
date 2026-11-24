(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.schema = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 'c4-design/1';
  var ELEMENT_TYPES = ['person', 'system', 'container', 'component', 'code'];
  var TOP_LEVEL_KEYS = ['schema', 'name', 'description', 'status', 'enterprise', 'view', 'requirements', 'groups',
    'people', 'systems', 'scenarios', 'deployment', 'decisions', 'views', 'checks', 'layout', 'vocabulary'];

  var COMMON_FIELDS = ['name', 'description', 'collaborators', 'tags', 'source'];
  var DESIGN_SLOTS = ['responsibilities', 'owns', 'provides', 'invariants', 'quality', 'choices'];
  var EXTERNAL_FIELDS = ['external', 'in_enterprise'];

  var FIELDS = {
    person: COMMON_FIELDS.concat(EXTERNAL_FIELDS, ['group']),
    system: COMMON_FIELDS.concat(EXTERNAL_FIELDS, ['group'], DESIGN_SLOTS, ['groups', 'containers']),
    container: COMMON_FIELDS.concat(['group', 'kind', 'technology'], DESIGN_SLOTS, ['stereotypes', 'groups', 'components']),
    component: COMMON_FIELDS.concat(['group', 'technology'], DESIGN_SLOTS, ['stereotypes', 'code']),
    code: COMMON_FIELDS.concat(['kind'], DESIGN_SLOTS, ['stereotypes', 'attributes', 'operations', 'extends', 'implements'])
  };

  var CHILD_KEY = { system: 'containers', container: 'components', component: 'code' };
  var CONTAINER_KINDS = ['application', 'browser_app', 'mobile_app', 'desktop_app', 'function', 'database',
    'file_store', 'queue', 'topic'];
  var CODE_KINDS = ['class', 'interface', 'abstract_class', 'enum', 'function', 'module'];
  var STEREOTYPES = ['information_holder', 'structurer', 'service_provider', 'coordinator', 'controller', 'interfacer'];
  var CONNECTORS = ['call', 'message', 'event', 'stream', 'shared-data'];
  var ASYNC_CONNECTORS = ['message', 'event', 'stream'];
  var NODE_KINDS = ['device', 'environment', 'infrastructure'];
  var STATUSES = ['sketch', 'proposed', 'accepted', 'implemented'];
  var DECISION_STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'];
  var REQUIREMENT_KINDS = ['functional', 'quality', 'constraint'];
  var FRAGMENTS = ['alt', 'par', 'opt', 'loop', 'break'];
  /** Fragments that hold a list of branches; the others hold one branch (spec §4.8). */
  var MULTI_BRANCH_FRAGMENTS = ['alt', 'par'];
  var VIEW_FIELDS = ['view', 'title', 'description', 'include', 'exclude', 'direction', 'annotations', 'show_title', 'derived'];
  var RESERVED_VIEW_IDS = ['landscape', 'context', 'containers', 'components', 'code', 'dynamic', 'deployment',
    'interfaces', 'interface'];
  var ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

  var CANONICAL_ORDER = ['name', 'description', 'kind', 'technology', 'external', 'in_enterprise', 'stereotypes', 'group',
    'responsibilities', 'collaborators', 'owns', 'provides', 'invariants', 'quality', 'choices',
    'containers', 'components', 'code', 'tags', 'source'];

  // Failsafe parsing keeps every scalar a string; only these fields are converted.
  var TYPED_FIELDS = {
    external: 'boolean', in_enterprise: 'boolean', show_title: 'boolean', derived: 'boolean',
    instances: 'integer', layoutCoordinate: 'number'
  };

  function pattern(required, extraRoles) {
    return { roles: required.concat(extraRoles || []), required: required };
  }
  var PATTERNS = {
    'Strategy': pattern(['Context', 'Strategy', 'ConcreteStrategy']),
    'State': pattern(['Context', 'State', 'ConcreteState']),
    'Observer': pattern(['Subject', 'Observer'], ['ConcreteSubject', 'ConcreteObserver']),
    'Command': pattern(['Command', 'ConcreteCommand', 'Receiver', 'Invoker']),
    'Adapter': pattern(['Target', 'Adapter', 'Adaptee']),
    'Facade': pattern(['Facade']),
    'Composite': pattern(['Component', 'Leaf', 'Composite']),
    'Singleton': pattern(['Singleton']),
    'Factory Method': pattern(['Creator', 'Product']),
    'Abstract Factory': pattern(['AbstractFactory', 'ConcreteFactory', 'AbstractProduct']),
    'Builder': pattern(['Builder', 'Director']),
    'Mediator': pattern(['Mediator', 'Colleague']),
    'Visitor': pattern(['Visitor', 'Element']),
    'MVC': pattern(['Model', 'View', 'Controller'])
  };
  var STYLES = ['layers', 'pipes-and-filters', 'publish-subscribe', 'client-server', 'microservices', 'event-driven'];

  function parseResponsibilityShorthand(str) {
    var match = /^(know|do|decide)\s+([\s\S]+)$/i.exec(String(str).trim());
    if (!match) return { kind: null, text: String(str).trim() };
    return { kind: match[1].toLowerCase(), text: match[2].trim() };
  }

  function parseStepShorthand(key) {
    var halves = String(key).split('->');
    if (halves.length !== 2) return null;
    var from = halves[0].trim();
    var to = halves[1].trim();
    return from && to ? { from: from, to: to } : null;
  }

  function parsePatternShorthand(str) {
    var text = String(str);
    var colon = text.indexOf(':');
    if (colon < 0) return { pattern: text.trim(), role: null };
    return { pattern: text.slice(0, colon).trim(), role: text.slice(colon + 1).trim() || null };
  }

  // ---- Interfaces: catalogs (spec §4.11, §7.2) ------------------------------------------------

  var INTERFACE_STYLES = ['rest', 'rpc', 'graphql', 'soap', 'message', 'event', 'stream', 'library', 'file'];
  var STYLE_LABELS = {
    rest: 'REST', rpc: 'RPC', graphql: 'GraphQL', soap: 'SOAP', message: 'Message', event: 'Event', stream: 'Stream',
    library: 'Library', file: 'File'
  };
  /** Styles whose operations a client calls and waits on, or sends commands to: they should state their errors. */
  var ERROR_WARNING_STYLES = ['rest', 'rpc', 'graphql', 'soap', 'message'];
  var SYNC_STYLES = ['rest', 'rpc', 'graphql', 'soap'];
  /** Styles whose provider emits the payload (the payload is `output`, J7 case 2). */
  var EMITTER_STYLES = ['event', 'stream'];
  /** Container kinds that carry messages between other elements (J7 cases 2 and 3). */
  var BROKER_KINDS = ['queue', 'topic'];

  // Canonical key orders for new entries (spec §4.11), used by the editor's splices and the unknown-key checks.
  var INTERFACE_ORDER = ['name', 'description', 'style', 'technology', 'version', 'restrictions', 'errors', 'operations',
    'types', 'vocabulary'];
  var OPERATION_ORDER = ['syntax', 'input', 'output', 'purpose', 'side_effects', 'restrictions', 'errors', 'examples',
    'realizes'];
  var TYPE_ORDER = ['description', 'fields'];
  var FIELD_ORDER = ['type', 'meaning', 'unit', 'format', 'required', 'values', 'constraints', 'example'];
  var EXAMPLE_KEYS = ['input', 'output', 'note'];
  var ERROR_KEYS = ['when', 'code'];
  var COLLABORATOR_ORDER = ['description', 'technology', 'connector', 'responsibility', 'uses', 'choices'];
  var STEP_KEYS = ['from', 'to', 'description', 'technology', 'connector', 'responsibility', 'uses'];

  var PRIMITIVE_TYPES = ['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'datetime', 'time', 'duration',
    'uuid', 'uri', 'binary', 'any'];
  var NUMERIC_TYPES = ['integer', 'number', 'decimal'];
  var TEMPORAL_TYPES = ['date', 'datetime', 'time', 'duration'];
  /** Spellings from other languages, read as the standard primitive (`interface/type-spelling`). */
  var TYPE_ALIASES = {
    str: 'string', int: 'integer', float: 'number', double: 'number', bool: 'boolean', dateTime: 'datetime',
    timestamp: 'datetime'
  };
  var TYPE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
  var FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  /** Field names that name an identifier (`id`, `student_id`, `sectionIds`): a number without a unit is fine there. */
  var IDENTIFIER_FIELD_PATTERN = /^id$|_ids?$|Ids?$/;
  var QUANTITY_WORDS = ['price', 'amount', 'cost', 'fee', 'weight', 'distance', 'size', 'temperature'];
  var DATE_WORDS = ['date', 'time', 'deadline', 'birthday', 'dob'];
  var DATE_SUFFIX_WORDS = ['at', 'on'];
  var HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  /** Words that name storage or runtime internals (`interface/leaks-implementation`); several are word sequences. */
  var LEAK_WORDS = ['sql', 'select', 'insert', 'table', 'column', 'row id', 'primary key', 'foreign key', 'orm', 'dao',
    'stored procedure', 'mutex', 'heap', 'pointer'];

  // ---- Interfaces: parsers (spec §4.11) -------------------------------------------------------

  var VISIBILITY_MARKER = /^[+\-#~]\s*/;
  var CALL_SYNTAX = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*\(/;
  var HTTP_SYNTAX = new RegExp('^(' + HTTP_METHODS.join('|') + ')\\s+(\\S+)');
  var OPERATION_ID_WORDS = 3;

  function stripMarks(text) {
    return String(text).normalize('NFKD').replace(/\p{M}/gu, '');
  }

  /** Lowercase words joined by `-`; runs of anything else become one separator. */
  function slug(text) {
    return asciiWords(text).join('-').toLowerCase();
  }

  /**
   * The id of a shorthand operation, derived from its syntax line (spec §4.11): the called identifier, the HTTP method
   * and path, or the first three words; `op` when that gives nothing that starts with a letter. The id is unique in
   * `takenSet`, which gains it, so deriving a list in order with one set gives `-2`, `-3` to repeats.
   */
  function deriveOperationId(syntax, takenSet) {
    var text = stripMarks(syntax).trim().replace(VISIBILITY_MARKER, '').replace(/^_+/, '');
    var call = CALL_SYNTAX.exec(text);
    var http = !call && HTTP_SYNTAX.exec(text);
    var base = call ? call[1]
      : http ? slug(http[1] + ' ' + http[2])
      : slug(text.split(/\s+/).slice(0, OPERATION_ID_WORDS).join(' '));
    var id = /^[A-Za-z]/.test(base) ? base : 'op';
    var unique = uniqueId(id, takenSet);
    takenSet.add(unique);
    return unique;
  }

  var GENERIC_LIST = /^(?:List|Array|array)<\s*([^<>]+?)\s*>$|^list\[\s*([^[\]]+?)\s*\]$/;

  /**
   * Reads a type expression (spec §4.11) to `{ name, list, primitive, canonical, spelling }`: `name` is a primitive
   * or a local type name, `canonical` the standard form (`string[]`), and `spelling` the written text when it is
   * another language's spelling (`str`, `List<str>`), else null. Text that is no type expression gives
   * `{ text, invalid: true }`.
   */
  function parseTypeExpression(text) {
    var written = String(text).trim();
    var generic = GENERIC_LIST.exec(written);
    var element = generic ? (generic[1] || generic[2]) : written.replace(/\[\]$/, '');
    var list = Boolean(generic) || element !== written;
    var name = Object.prototype.hasOwnProperty.call(TYPE_ALIASES, element) ? TYPE_ALIASES[element] : element;
    if (!TYPE_NAME_PATTERN.test(name)) return { text: written, invalid: true };
    var canonical = list ? name + '[]' : name;
    return {
      name: name, list: list, primitive: PRIMITIVE_TYPES.indexOf(name) >= 0, canonical: canonical,
      spelling: canonical === written ? null : written
    };
  }

  /** Splits a `uses` entry `<interface>` or `<interface>.<operation>`; ids contain no dots. */
  function parseUsesRef(text) {
    var parts = String(text).trim().split('.');
    var valid = parts.length <= 2 && parts.every(function (part) { return ID_PATTERN.test(part); });
    if (!valid) return { error: 'uses-syntax' };
    return { interfaceId: parts[0], operationId: parts.length === 2 ? parts[1] : null };
  }

  /** The `{name}` placeholders of a syntax line, in order. */
  function placeholders(syntax) {
    var names = [];
    String(syntax).replace(/\{([^{}]+)\}/g, function (match, name) { names.push(name.trim()); return match; });
    return names;
  }

  /**
   * The lowercase words of a name or syntax line, split at every character that is not a letter or digit (`_`, `-`,
   * `.`, `/`, spaces, brackets) and where a lowercase letter meets an uppercase one (`SeatTable` → seat, table).
   */
  function splitWords(name) {
    return String(name).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/)
      .filter(Boolean).map(function (word) { return word.toLowerCase(); });
  }

  function containsSequence(words, sequence) {
    for (var start = 0; start + sequence.length <= words.length; start++) {
      var matches = sequence.every(function (word, offset) { return words[start + offset] === word; });
      if (matches) return true;
    }
    return false;
  }

  /** The entries of `LEAK_WORDS` whose words appear, in sequence, among the words of `text`, in catalog order. */
  function leakWords(text) {
    var words = splitWords(text);
    return LEAK_WORDS.filter(function (leak) { return containsSequence(words, leak.split(' ')); });
  }

  // ---- View selectors (spec §5.1, §4.10) ------------------------------------------------------
  //
  // Keywords match ignoring case; element, scenario, environment, and custom view ids are matched exactly, because
  // they are YAML keys (Ruling 16: `components of API` does not name `api`). Interface ids are unique ignoring case
  // (spec §4.11), so the grammar lowercases them.

  /** The element type each element-scoped view is drawn for. */
  var ELEMENT_SCOPE_TYPES = { context: 'system', containers: 'system', components: 'container', code: 'component' };
  var SELECTOR_KEYWORDS = {
    'system context': 'context', context: 'context', container: 'containers', containers: 'containers',
    component: 'components', components: 'components', code: 'code', dynamic: 'dynamic', deployment: 'deployment'
  };
  // The first group of the element, interfaces, and interface selectors is the text before the first id, so a rename
  // can keep how the rest is written (withSelectorScope).
  var ELEMENT_SELECTOR = /^(\s*(system\s+context|context|containers?|components?|code)\s+of\s+)(\S+)\s*$/i;
  var NAMED_SELECTOR = /^\s*(dynamic|deployment)\s+(\S+)\s*$/i;
  var INTERFACES_SELECTOR = /^(\s*interfaces\s+of\s+)(\S+)\s*$/i;
  var INTERFACE_SELECTOR = /^(\s*interface\s+)(\S+)(?:(\s+of\s+)(\S+))?\s*$/i;
  var ANNOTATION_SUFFIX = /^(.*\S)\s+with\s+(\S.*)$/i;
  var SELECTOR_SYNTAX = 'use landscape, context of <system>, containers of <system>, components of <container>, ' +
    'code of <component>, dynamic <scenario>, deployment <environment>, interfaces of <element>, ' +
    'interface <interface>, or a custom view id, optionally followed by "with" and annotations';

  /** The annotations a view may carry (`views.*.annotations`, the `with …` suffix). */
  var ANNOTATION_VALUES = ['interfaces', 'patterns', 'styles', 'tactics'];
  /** The base view types each annotation is allowed on (spec §5.1); a custom view counts as its base. */
  var ANNOTATION_BASES = {
    interfaces: ['landscape', 'context', 'containers', 'components', 'dynamic'],
    styles: ['landscape', 'context', 'containers', 'components'],
    tactics: ['landscape', 'context', 'containers', 'components'],
    patterns: ['landscape', 'context', 'containers', 'components', 'code']
  };
  /** The fields a custom view based on an interface view accepts (spec §4.8). */
  var INTERFACE_VIEW_FIELDS = {
    interfaces: ['view', 'title', 'description', 'show_title', 'exclude', 'direction'],
    interface: ['view', 'title', 'description', 'show_title']
  };

  function selectorKeyword(written) {
    return SELECTOR_KEYWORDS[written.toLowerCase().replace(/\s+/g, ' ')];
  }

  /** True when `id` is a built-in view keyword, compared ignoring case, so it cannot be a custom view id. */
  function isReservedViewId(id) {
    return RESERVED_VIEW_IDS.indexOf(String(id).toLowerCase()) >= 0;
  }

  /**
   * Parses selector text (spec §5.1 grammar) to
   * `{ type, scopeId, interfaceId, ofId, viewId, annotations, base, canonical }`, or `{ error }` for malformed syntax.
   * `type` is `landscape`, an element-scoped type (`context`, `containers`, `components`, `code`), `dynamic`,
   * `deployment`, `interfaces`, `interface`, or `custom`. `annotations` is the sorted `with …` list, `base` the
   * canonical text without it (the view key), and `canonical` the whole canonical text.
   */
  function parseSelector(text) {
    var written = String(text);
    var suffix = ANNOTATION_SUFFIX.exec(written);
    var base = parseBase(suffix ? suffix[1] : written);
    if (!base) return { error: JSON.stringify(written) + ' is not a view selector; ' + SELECTOR_SYNTAX };
    var annotations = suffix ? parseAnnotations(suffix[2]) : [];
    if (annotations.error) return annotations;
    base.annotations = annotations;
    base.base = canonicalBase(base);
    base.canonical = canonicalSelector(base);
    return base;
  }

  /** The selector fields of a base view, or null when `text` is no base. */
  function parseBase(text) {
    var scoped = ELEMENT_SELECTOR.exec(text);
    if (scoped) return selectorParts(selectorKeyword(scoped[2]), { scopeId: scoped[3] });
    var named = NAMED_SELECTOR.exec(text);
    if (named) return selectorParts(selectorKeyword(named[1]), { scopeId: named[2] });
    var interfaces = INTERFACES_SELECTOR.exec(text);
    if (interfaces) return selectorParts('interfaces', { scopeId: interfaces[2] });
    var single = INTERFACE_SELECTOR.exec(text);
    if (single) return selectorParts('interface', { interfaceId: single[2].toLowerCase(), ofId: single[4] || null });
    var trimmed = text.trim();
    if (trimmed.toLowerCase() === 'landscape') return selectorParts('landscape', {});
    if (ID_PATTERN.test(trimmed) && !isReservedViewId(trimmed)) return selectorParts('custom', { viewId: trimmed });
    return null;
  }

  function selectorParts(type, ids) {
    return {
      type: type, scopeId: ids.scopeId || null, interfaceId: ids.interfaceId || null, ofId: ids.ofId || null,
      viewId: ids.viewId || null, annotations: [], base: null, canonical: null
    };
  }

  /** The comma-separated annotation list after `with`: lowercased, without repeats, sorted; or `{ error }`. */
  function parseAnnotations(text) {
    var names = text.split(',').map(function (name) { return name.trim().toLowerCase(); });
    var unknown = names.filter(function (name) { return ANNOTATION_VALUES.indexOf(name) < 0; });
    if (unknown.length > 0) {
      return { error: JSON.stringify(unknown[0]) + ' is not a view annotation; use ' + ANNOTATION_VALUES.join(', ') };
    }
    return names.filter(function (name, index) { return names.indexOf(name) === index; }).sort();
  }

  /**
   * The canonical text (spec §4.10) of a parsed selector, or of `{ type, scopeId }` and the like: lowercase plural
   * keyword, single spaces, element ids as declared, interface ids lowercase, annotations sorted after `with`.
   */
  function canonicalSelector(parsed) {
    var annotations = parsed.annotations || [];
    var suffix = annotations.length > 0 ? ' with ' + annotations.join(', ') : '';
    return canonicalBase(parsed) + suffix;
  }

  function canonicalBase(parsed) {
    if (parsed.type === 'landscape') return 'landscape';
    if (parsed.type === 'custom') return parsed.viewId;
    if (parsed.type === 'interface') return 'interface ' + parsed.interfaceId.toLowerCase();
    if (parsed.type === 'interfaces' || ELEMENT_SCOPE_TYPES[parsed.type]) return parsed.type + ' of ' + parsed.scopeId;
    return parsed.type + ' ' + parsed.scopeId;
  }

  /**
   * The key of the view a selector names (layout keys, `ViewModel.key`): the canonical base without the `with …`
   * suffix, so a plain and an annotated view share pins. Takes a parsed selector or selector text; malformed text
   * keeps its words, trimmed.
   */
  function selectorKey(selectorOrText) {
    var parsed = typeof selectorOrText === 'string' ? parseSelector(selectorOrText) : selectorOrText;
    return parsed.error ? String(selectorOrText).trim().replace(/\s+/g, ' ') : parsed.base;
  }

  /**
   * `text` with the ids a selector names renamed, keeping how everything else is written, `with …` suffix included.
   * `renameElement(id)` gives the new element id of an element-scoped or `interfaces of` selector and of the `of`
   * clause of an interface selector; `renameInterface(id)` gives the new interface id, called with the id as
   * written. Malformed selectors, and selectors that name no element or interface, are returned unchanged.
   */
  function withSelectorScope(text, renameElement, renameInterface) {
    var written = String(text);
    if (parseSelector(written).error) return written;
    var suffix = ANNOTATION_SUFFIX.exec(written);
    var baseEnd = suffix ? suffix[1].length : written.length;
    return renamedBase(written.slice(0, baseEnd), renameElement, renameInterface) + written.slice(baseEnd);
  }

  // Every selector renamedBase rewrites ends with an id, so whatever follows the trimmed text is kept as written.
  function renamedBase(base, renameElement, renameInterface) {
    var rest = base.slice(base.replace(/\s+$/, '').length);
    var scoped = ELEMENT_SELECTOR.exec(base);
    if (scoped) return scoped[1] + renameElement(scoped[3]) + rest;
    var interfaces = INTERFACES_SELECTOR.exec(base);
    if (interfaces) return interfaces[1] + renameElement(interfaces[2]) + rest;
    var single = INTERFACE_SELECTOR.exec(base);
    if (!single) return base;
    var ofClause = single[3] ? single[3] + renameElement(single[4]) : '';
    return single[1] + renameInterface(single[2]) + ofClause + rest;
  }

  // ---- Layout entries of UML-notation views (UML-view editing spec §4.2) -------------------------
  //
  // Under the key of a view drawn in C4 notation a layout entry maps element ids to positions. Under the key of a
  // UML-notation view it holds named parts, so a part name never collides with an element id.

  /** The parts the layout entry of each UML-notation view type holds; the other view types hold a pin map. */
  var UML_LAYOUT_PARTS = {
    code: ['positions', 'routes'], deployment: ['positions', 'routes'], interfaces: ['positions'], dynamic: ['lifelines']
  };
  /** Every part name, in the order an entry writes them. */
  var LAYOUT_PART_ORDER = ['positions', 'routes', 'lifelines'];
  /** The `relation` a route may name in each view type that keeps routes. */
  var ROUTE_RELATIONS = { code: ['collaborator'], deployment: ['link', 'derived'] };
  var ROUTE_KEYS = ['from', 'to', 'relation', 'points'];

  /**
   * The view a layout key stands for, as `{ type, scopeId }` of its base view, or null for a key that names no view: a
   * malformed selector, or a custom view id that `customSelector(viewId)` gives no selector for. A custom view stands
   * for the view its `view` selector names.
   */
  function layoutView(key, customSelector) {
    var parsed = parseSelector(String(key));
    if (parsed.error) return null;
    if (parsed.type !== 'custom') return { type: parsed.type, scopeId: parsed.scopeId };
    var text = customSelector(parsed.viewId);
    var base = typeof text === 'string' ? parseSelector(text) : null;
    return base && !base.error && base.type !== 'custom' ? { type: base.type, scopeId: base.scopeId } : null;
  }

  // Optimal-string-alignment distance: insert, delete, substitute, or swap adjacent characters.
  function editDistance(a, b) {
    var rows = [];
    for (var i = 0; i <= a.length; i++) {
      rows.push([i]);
      for (var j = 1; j <= b.length; j++) {
        if (i === 0) { rows[0].push(j); continue; }
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        var best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          best = Math.min(best, rows[i - 2][j - 2] + 1);
        }
        rows[i].push(best);
      }
    }
    return rows[a.length][b.length];
  }

  var MAX_SUGGESTION_DISTANCE = 2;
  function suggest(word, candidates) {
    var closest = null;
    var closestDistance = MAX_SUGGESTION_DISTANCE + 1;
    candidates.forEach(function (candidate) {
      var distance = editDistance(String(word), candidate);
      if (distance < closestDistance) { closest = candidate; closestDistance = distance; }
    });
    return closest;
  }

  function asciiWords(name) {
    var folded = String(name).normalize('NFKD').replace(/\p{M}/gu, '');
    return folded.split(/[^A-Za-z0-9]+/).filter(Boolean);
  }

  function slugify(name, type) {
    var words = asciiWords(name);
    var slug = type === 'code'
      ? words.map(function (word) { return word.charAt(0).toUpperCase() + word.slice(1); }).join('')
      : words.join('-').toLowerCase();
    if (!slug) return type;
    return /^[A-Za-z]/.test(slug) ? slug : type.charAt(0) + '-' + slug;
  }

  function uniqueId(base, takenSet) {
    if (!takenSet.has(base)) return base;
    var suffix = 2;
    while (takenSet.has(base + '-' + suffix)) suffix++;
    return base + '-' + suffix;
  }

  // ---- JSON Schema (spec §3, J1) --------------------------------------------------------------

  var JSON_SCHEMA_ID = 'https://tobiasduerschmid.github.io/js/ArchUML/c4/schema/1/design.schema.json';
  var DIRECTIONS = ['down', 'right'];
  var EXTENSION_KEYS = '^x-';

  function definition(name) { return { $ref: '#/definitions/' + name }; }
  function enumOf(values) { return { enum: values.slice() }; }
  function listOf(items) { return { type: 'array', items: items }; }
  function oneOf(alternatives) { return { anyOf: alternatives }; }

  /** A map with fixed keys; `x-*` keys are allowed and anything else is rejected. */
  function objectOf(properties) {
    var patternProperties = {};
    patternProperties[EXTENSION_KEYS] = {};
    return { type: 'object', properties: properties, patternProperties: patternProperties, additionalProperties: false };
  }

  /** A map whose keys match `keyPattern` (an id by default) and whose values follow `valueSchema`. */
  function mapOf(valueSchema, keyPattern) {
    var patternProperties = {};
    patternProperties[keyPattern || ID_PATTERN.source] = valueSchema;
    return { type: 'object', patternProperties: patternProperties, additionalProperties: false };
  }

  /** The property schemas of one element type, restricted to the fields `FIELDS` allows on it. */
  function elementProperties(type) {
    var text = definition('text');
    var textList = listOf(text);
    var byField = {
      name: text, description: text, technology: text, group: text, source: text,
      tags: textList, owns: textList,
      provides: type === 'code' ? textList : definition('provides'), invariants: textList, quality: textList,
      external: definition('boolean'), in_enterprise: definition('boolean'),
      kind: enumOf(type === 'container' ? CONTAINER_KINDS : CODE_KINDS),
      collaborators: mapOf(definition('collaborator')), responsibilities: listOf(definition('responsibility')),
      choices: definition('choices'), stereotypes: listOf(enumOf(STEREOTYPES)), groups: mapOf(definition('group')),
      attributes: textList, operations: textList, extends: oneOf([text, textList]), implements: oneOf([text, textList]),
      containers: mapOf(definition('container')), components: mapOf(definition('component')), code: mapOf(definition('code'))
    };
    var properties = {};
    FIELDS[type].forEach(function (field) { properties[field] = byField[field]; });
    return properties;
  }

  function scenarioStep() {
    var text = definition('text');
    var step = objectOf({
      from: text, to: text, description: text, technology: text, connector: enumOf(CONNECTORS), responsibility: text, uses: text,
      alt: listOf(definition('branch')), par: listOf(definition('branch')),
      opt: definition('branch'), loop: definition('branch'), 'break': definition('branch')
    });
    step.patternProperties['.+->.+'] = text; // the shorthand "a -> b": description
    return step;
  }

  function jsonSchemaDefinitions() {
    var text = definition('text');
    var textList = listOf(text);
    var textOrList = oneOf([text, textList]);
    return Object.assign({
      text: { type: ['string', 'number', 'boolean'] },
      boolean: oneOf([{ type: 'boolean' }, enumOf(['true', 'false'])]),
      integer: oneOf([{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[0-9]+$' }]),
      number: oneOf([{ type: 'number' }, { type: 'string', pattern: '^-?[0-9]+(\\.[0-9]+)?$' }]),
      collaborator: oneOf([text, objectOf({
        description: text, technology: text, connector: enumOf(CONNECTORS), responsibility: text, uses: textOrList,
        choices: definition('choices')
      })]),
      responsibility: oneOf([text, objectOf({
        know: text, 'do': text, decide: text, id: text, refines: textOrList, requirements: textOrList
      })]),
      choices: objectOf({
        technology: objectOf({ chosen: text, alternatives: textList, because: text, decision: text }),
        styles: listOf(enumOf(STYLES)),
        patterns: listOf(oneOf([text, objectOf({ pattern: text, role: text, instance: text, decision: text })])),
        tactics: textList
      }),
      group: objectOf({ name: text, description: text }),
      person: objectOf(elementProperties('person')),
      system: objectOf(elementProperties('system')),
      container: objectOf(elementProperties('container')),
      component: objectOf(elementProperties('component')),
      code: objectOf(elementProperties('code')),
      branch: objectOf({ when: text, steps: listOf(definition('step')) }),
      step: oneOf([text, scenarioStep()]),
      scenario: objectOf({ title: text, description: text, steps: listOf(definition('step')) }),
      node: objectOf({
        name: text, description: text, kind: enumOf(NODE_KINDS), technology: text, instances: definition('integer'),
        hosts: textList, nodes: mapOf(definition('node')), tags: textList,
        collaborators: mapOf(oneOf([text, objectOf({ description: text, technology: text })]))
      }),
      environment: objectOf({ name: text, description: text, nodes: mapOf(definition('node')) }),
      decision: objectOf({
        title: text, status: enumOf(DECISION_STATUSES), context: text, decision: text, alternatives: textList,
        consequences: text, affects: textList, supersedes: textOrList, date: text
      }),
      requirement: oneOf([text, objectOf({ text: text, kind: enumOf(REQUIREMENT_KINDS) })]),
      view: viewDefinition()
    }, interfaceDefinitions());
  }

  /** A regular expression source matching `word` in any letter case, as selector keywords do (spec §5.1). */
  function caseInsensitive(word) {
    return word.replace(/[a-z]/gi, function (letter) { return '[' + letter.toLowerCase() + letter.toUpperCase() + ']'; });
  }

  /** A custom view accepts the fields its base view type accepts (spec §4.8): fewer on the interface views. */
  function viewDefinition() {
    var text = definition('text');
    var properties = {
      view: text, title: text, description: text, include: listOf(text), exclude: listOf(text),
      direction: enumOf(DIRECTIONS), annotations: listOf(enumOf(ANNOTATION_VALUES)),
      show_title: definition('boolean'), derived: definition('boolean')
    };
    var only = function (fields) {
      var allowed = {};
      fields.forEach(function (field) { allowed[field] = properties[field]; });
      return objectOf(allowed);
    };
    var basedOn = function (pattern) {
      return { required: ['view'], properties: { view: { type: 'string', pattern: '^\\s*' + pattern } } };
    };
    return {
      'if': basedOn(caseInsensitive('interfaces') + '\\s+' + caseInsensitive('of') + '\\s'),
      then: only(INTERFACE_VIEW_FIELDS.interfaces),
      'else': {
        'if': basedOn(caseInsensitive('interface') + '\\s'),
        then: only(INTERFACE_VIEW_FIELDS.interface),
        'else': only(VIEW_FIELDS)
      }
    };
  }

  /** The interface descriptions of `provides`, and the types, fields, and errors inside them (spec §4.11). */
  function interfaceDefinitions() {
    var text = definition('text');
    var textList = listOf(text);
    var textOrList = oneOf([text, textList]);
    var withOneOf = function (node, keys) {
      node.anyOf = keys.map(function (key) { return { required: [key] }; });
      return node;
    };
    return {
      provides: oneOf([textList, mapOf(definition('interface'))]),
      'interface': objectOf({
        name: text, description: text, style: enumOf(INTERFACE_STYLES), technology: text, version: text,
        restrictions: textOrList, errors: mapOf(definition('error')), operations: mapOf(definition('operation')),
        types: mapOf(definition('typeDefinition'), TYPE_NAME_PATTERN.source), vocabulary: mapOf(text, '.+')
      }),
      operation: oneOf([text, objectOf({
        syntax: text, input: definition('typeUse'), output: definition('typeUse'), purpose: text,
        side_effects: textOrList, restrictions: textOrList, errors: mapOf(definition('error')),
        examples: listOf(definition('example')), realizes: textOrList
      })]),
      typeUse: oneOf([text, mapOf(definition('field'), FIELD_NAME_PATTERN.source)]),
      typeDefinition: objectOf({
        description: text, fields: mapOf(definition('field'), FIELD_NAME_PATTERN.source)
      }),
      field: oneOf([text, objectOf({
        type: text, meaning: text, unit: text, format: text, required: definition('boolean'),
        values: oneOf([textList, mapOf(text, '.+')]), constraints: textOrList, example: {}
      })]),
      error: oneOf([text, objectOf({ when: text, code: text })]),
      example: withOneOf(objectOf({ input: {}, output: {}, note: text }), EXAMPLE_KEYS)
    };
  }

  /**
   * Regular expression sources, without `^`, of the layout keys whose entry holds named parts (spec §4.2): a selector of
   * each UML-notation view type in any letter case, with the optional `with` and annotations a view key may carry; and
   * a custom view id (`custom`), which the schema cannot follow to the view it is based on.
   */
  function layoutKeyPatterns() {
    var annotation = '(?:' + ANNOTATION_VALUES.map(caseInsensitive).join('|') + ')';
    var suffix = '(?:\\s+' + caseInsensitive('with') + '\\s+' + annotation + '(?:\\s*,\\s*' + annotation + ')*)?\\s*$';
    var selector = function (words) { return '\\s*' + words.map(caseInsensitive).join('\\s+') + '\\s+\\S+' + suffix; };
    var reserved = '(?:' + RESERVED_VIEW_IDS.map(caseInsensitive).join('|') + ')(?![A-Za-z0-9_-])';
    return {
      code: selector(['code', 'of']), deployment: selector(['deployment']), dynamic: selector(['dynamic']),
      interfaces: selector(['interfaces', 'of']), custom: '\\s*(?!' + reserved + ')[A-Za-z][A-Za-z0-9_-]*' + suffix
    };
  }

  /**
   * The `layout` section: the named parts under the key of each UML-notation view type, a pin map under any other key,
   * and either under a custom view's key.
   */
  function layoutDefinition(position) {
    var text = definition('text');
    var points = { type: 'array', items: position, minItems: 2 };
    var partSchemas = function (relations) {
      var route = objectOf({ from: text, to: text, relation: enumOf(relations), points: points });
      route.required = ROUTE_KEYS.slice();
      return { positions: mapOf(position), routes: listOf(route), lifelines: listOf(text) };
    };
    var entryOf = function (parts, relations) {
      var schemas = partSchemas(relations);
      var properties = {};
      parts.forEach(function (part) { properties[part] = schemas[part]; });
      return objectOf(properties);
    };
    var keys = layoutKeyPatterns();
    var patternProperties = {};
    Object.keys(UML_LAYOUT_PARTS).forEach(function (type) {
      patternProperties['^' + keys[type]] = entryOf(UML_LAYOUT_PARTS[type], ROUTE_RELATIONS[type] || []);
    });
    var anyRelation = ROUTE_RELATIONS.code.concat(ROUTE_RELATIONS.deployment);
    patternProperties['^' + keys.custom] = oneOf([mapOf(position), entryOf(LAYOUT_PART_ORDER, anyRelation)]);
    var named = Object.keys(keys).map(function (type) { return '(?:' + keys[type] + ')'; });
    patternProperties['^(?!' + named.join('|') + ')'] = mapOf(position);
    return { type: 'object', patternProperties: patternProperties, additionalProperties: false };
  }

  /** The JSON Schema (draft-07) of a `c4-design/1` file, for yaml-language-server and VS Code. */
  function toJsonSchema() {
    var text = definition('text');
    var position = { type: 'array', items: definition('number'), minItems: 2, maxItems: 2 };
    var document = objectOf({
      schema: text, name: text, description: text, status: enumOf(STATUSES), enterprise: text, view: text,
      requirements: mapOf(definition('requirement')), groups: mapOf(definition('group')),
      people: mapOf(definition('person')), systems: mapOf(definition('system')),
      scenarios: mapOf(definition('scenario')), deployment: mapOf(definition('environment')), vocabulary: mapOf(text, '.+'),
      decisions: mapOf(definition('decision')), views: mapOf(definition('view')),
      checks: objectOf({ ignore: listOf(objectOf({ rule: text, element: text, because: text })) }),
      layout: layoutDefinition(position)
    });
    return Object.assign({ $schema: 'http://json-schema.org/draft-07/schema#', $id: JSON_SCHEMA_ID,
      title: 'C4 design model (' + SCHEMA_VERSION + ')' }, document, { definitions: jsonSchemaDefinitions() });
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION, ELEMENT_TYPES: ELEMENT_TYPES, TOP_LEVEL_KEYS: TOP_LEVEL_KEYS, FIELDS: FIELDS,
    CHILD_KEY: CHILD_KEY, CONTAINER_KINDS: CONTAINER_KINDS, CODE_KINDS: CODE_KINDS, STEREOTYPES: STEREOTYPES,
    CONNECTORS: CONNECTORS, ASYNC_CONNECTORS: ASYNC_CONNECTORS, NODE_KINDS: NODE_KINDS, STATUSES: STATUSES,
    DECISION_STATUSES: DECISION_STATUSES, REQUIREMENT_KINDS: REQUIREMENT_KINDS, FRAGMENTS: FRAGMENTS,
    MULTI_BRANCH_FRAGMENTS: MULTI_BRANCH_FRAGMENTS,
    VIEW_FIELDS: VIEW_FIELDS, RESERVED_VIEW_IDS: RESERVED_VIEW_IDS, ID_PATTERN: ID_PATTERN,
    CANONICAL_ORDER: CANONICAL_ORDER, TYPED_FIELDS: TYPED_FIELDS, PATTERNS: PATTERNS, STYLES: STYLES,
    toJsonSchema: toJsonSchema,
    ELEMENT_SCOPE_TYPES: ELEMENT_SCOPE_TYPES, parseSelector: parseSelector, canonicalSelector: canonicalSelector,
    selectorKey: selectorKey, withSelectorScope: withSelectorScope, isReservedViewId: isReservedViewId,
    UML_LAYOUT_PARTS: UML_LAYOUT_PARTS, LAYOUT_PART_ORDER: LAYOUT_PART_ORDER, ROUTE_RELATIONS: ROUTE_RELATIONS,
    ROUTE_KEYS: ROUTE_KEYS, layoutView: layoutView,
    parseResponsibilityShorthand: parseResponsibilityShorthand, parseStepShorthand: parseStepShorthand,
    parsePatternShorthand: parsePatternShorthand, suggest: suggest, slugify: slugify, uniqueId: uniqueId,
    ANNOTATION_VALUES: ANNOTATION_VALUES, ANNOTATION_BASES: ANNOTATION_BASES, INTERFACE_VIEW_FIELDS: INTERFACE_VIEW_FIELDS,
    INTERFACE_STYLES: INTERFACE_STYLES, STYLE_LABELS: STYLE_LABELS, ERROR_WARNING_STYLES: ERROR_WARNING_STYLES,
    SYNC_STYLES: SYNC_STYLES, EMITTER_STYLES: EMITTER_STYLES, BROKER_KINDS: BROKER_KINDS,
    INTERFACE_ORDER: INTERFACE_ORDER, OPERATION_ORDER: OPERATION_ORDER, TYPE_ORDER: TYPE_ORDER, FIELD_ORDER: FIELD_ORDER,
    EXAMPLE_KEYS: EXAMPLE_KEYS, ERROR_KEYS: ERROR_KEYS, COLLABORATOR_ORDER: COLLABORATOR_ORDER, STEP_KEYS: STEP_KEYS,
    PRIMITIVE_TYPES: PRIMITIVE_TYPES, NUMERIC_TYPES: NUMERIC_TYPES, TEMPORAL_TYPES: TEMPORAL_TYPES,
    TYPE_ALIASES: TYPE_ALIASES, TYPE_NAME_PATTERN: TYPE_NAME_PATTERN, FIELD_NAME_PATTERN: FIELD_NAME_PATTERN,
    IDENTIFIER_FIELD_PATTERN: IDENTIFIER_FIELD_PATTERN, QUANTITY_WORDS: QUANTITY_WORDS, DATE_WORDS: DATE_WORDS,
    DATE_SUFFIX_WORDS: DATE_SUFFIX_WORDS, HTTP_METHODS: HTTP_METHODS, LEAK_WORDS: LEAK_WORDS,
    deriveOperationId: deriveOperationId, parseTypeExpression: parseTypeExpression, parseUsesRef: parseUsesRef,
    placeholders: placeholders, splitWords: splitWords, leakWords: leakWords
  };
});
