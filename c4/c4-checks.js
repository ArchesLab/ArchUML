(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-projection.js'), require('./c4-yaml.js'), require('./c4-schema.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.checks = factory(parts.projection, parts.yaml, parts.schema);
  }
})(typeof self !== 'undefined' ? self : this, function (projection, yamlAdapter, schema) {
  'use strict';

  // The consistency checks (spec §7): the rule catalog, the runner for semantic rules, and the configuration
  // step that suppresses, disables, and re-rates diagnostics.

  const SEVERITIES = ['error', 'warning', 'info'];
  const DEFAULT_THRESHOLDS = { viewElements: 20, unrefinedResponsibilities: 9, collaborators: 7 };
  // Rules that report a gap the author has not had time to fill yet; the novice profile holds them back (spec §7.2).
  const INCOMPLETENESS_RULES = new Set(['c4/no-description', 'rdd/no-responsibility', 'c4/no-technology', 'c4/isolated-element',
    'interface/no-syntax', 'interface/untyped-field', 'interface/undefined-type', 'interface/no-purpose',
    'interface/no-errors', 'interface/no-unit', 'interface/no-format']);

  const BOX_TYPES = ['person', 'system', 'container', 'component'];
  const UNDESCRIBED_TECHNOLOGY_KINDS = ['database', 'file_store'];
  const SPARSE_DESCRIPTION_WORDS = 4;
  const VAGUE_RELATIONSHIP_WORDS = 2;
  const TBD_TECHNOLOGY = /^tbd$/i;
  const INFRASTRUCTURE_TECHNOLOGY = /\b(docker|kubernetes|vm|jar|dll)\b/i;
  const BROKER_LOOKALIKE = /\b(kafka|rabbitmq|activemq|pulsar|nats|mqtt|sqs|sns|broker|message bus|event bus)\b/i;
  const GENERIC_NAME_BASES = ['service', 'component', 'module', 'system', 'container', 'app', 'application', 'server', 'db',
    'database', 'client', 'backend', 'frontend', 'business logic'];
  // A generic word, optionally followed by a single letter or a number: "Service A", "DB1", "Backend".
  const GENERIC_NAME = new RegExp(`^(?:${GENERIC_NAME_BASES.join('|')})(?:[\\s_-]*(?:[a-z]|[0-9]+))?$`, 'i');

  const DESIGN_TYPES = ['system', 'container', 'component', 'code'];
  const DATA_STORE_KINDS = ['database', 'file_store'];
  // Texts that read as code or as a user-interface step instead of an obligation (spec §7.2 rdd/not-an-obligation):
  // an HTTP request, a method call, a getter or setter ("set up" is an ordinary verb), a click, press, or tap.
  const NON_OBLIGATION_PATTERNS = [
    /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S*/i,
    /^[A-Za-z_$][\w$.]*\(/,
    /^(?:[gG]et|[sS]et)(?:[A-Z_]|\s+(?!up\b)\S)/,
    /^(?:click|press|tap)(?:e?s)?\b/i,
  ];
  // A lone identifier reads as a field only when it is code-shaped: camelCase, snake_case, dotted, or with $ or a
  // digit (`seatCount`, `seat_count`, `plan.term`). A plain word such as "prerequisites" or "enroll" is a sketch.
  const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
  const CODE_SHAPED = /[a-z][A-Z]|[_$.]|[A-Za-z][0-9]/;
  const VAGUE_VERB = /^(?:handle|manage|process|support)(?:e?s)?\b/i;
  const VAGUE_MAX_NOUNS = 1;
  const ARTICLES = new Set(['a', 'an', 'the', 'all']);
  // Words that carry no meaning when comparing two decisions (rdd/duplicate-decision).
  const DECISION_STOPWORDS = new Set(['and', 'any', 'are', 'can', 'each', 'every', 'for', 'from', 'how', 'into', 'its', 'may',
    'must', 'should', 'that', 'the', 'their', 'this', 'what', 'when', 'where', 'whether', 'which', 'who', 'will', 'with']);
  const NEAR_DUPLICATE_DECISION = 0.6;
  const MANAGER_NAME = /(?:manager|processor|handler|helper|utils?)$/i;
  const CENTRALIZED_CONTROL_SIBLINGS = 3;
  const SEQUENCING_DECISION = /\b(?:next|sequenc\w*|steps?)\b/i;
  const NUMBER_WITH_UNIT = /\d\s*(?:%|[A-Za-zµ]+)/;
  const COMPARATOR = /[<>≤≥]|\b(?:at (?:most|least)|no (?:more|later) than|(?:less|more|fewer|greater|faster|slower|higher|lower|better|worse) than)\b/i;
  const LEVEL_VIEW_TYPES = ['containers', 'components'];
  const OVERVIEW_VIEW_TYPES = ['landscape', 'context', 'containers', 'components'];

  // ---- Rule catalog --------------------------------------------------------------------------

  const BROWN = 'Brown (c4model.com)';
  const SCHEMA_SOURCE = 'design.yml schema (spec §4)';
  const RDD = 'Wirfs-Brock & McKean 2003';
  const PATTERN_SOURCE = 'SEBook design-pattern and architectural-style chapters';
  const INTERFACE_REFERENCE_RATIONALE = 'A reference that contradicts containment or the direction of a contract is invalid, like model/responsibility-owner.';

  function rule(id, severity, title, rationale, source, check = null) {
    const definition = { id, severity, category: id.slice(0, id.indexOf('/')), title, rationale, source };
    return check ? Object.assign(definition, { check }) : definition;
  }

  /**
   * Rules that the parser and the model reader report; they are listed here for the help text and REFERENCE.md. The two
   * selector rules are also checked here for saved views, whose selectors only projection resolves (spec §4.8, §7.2).
   */
  const STRUCTURAL_RULES = [
    rule('yaml/syntax', 'error', 'YAML syntax error', 'A file that is not valid YAML cannot be read at all.', SCHEMA_SOURCE),
    rule('schema/version', 'error', 'Unknown schema version', 'The editor reads only c4-design/1; a CS 188 RDD file uses a different format, and an opened file should declare its format.', SCHEMA_SOURCE),
    rule('schema/unknown-key', 'error', 'Unknown key', 'A misspelled key is silently ignored by readers, so it is reported with a suggestion.', SCHEMA_SOURCE),
    rule('schema/type', 'error', 'Wrong value type', 'A text where a list belongs, or the reverse, cannot be interpreted.', SCHEMA_SOURCE),
    rule('schema/value', 'error', 'Value outside its enumeration', 'Kinds, connectors, statuses, and the like come from fixed lists.', SCHEMA_SOURCE),
    rule('schema/id-format', 'error', 'Invalid id', 'Ids start with a letter and use letters, digits, hyphens, and underscores, so selectors and references stay unambiguous.', SCHEMA_SOURCE),
    rule('schema/misplaced-field', 'error', 'Field not allowed on this element type', 'Some fields only make sense on some element types, for example technology on a container.', SCHEMA_SOURCE),
    rule('model/duplicate-id', 'error', 'Id reused', 'References resolve by id, so an id names exactly one thing in its namespace.', SCHEMA_SOURCE),
    rule('model/unknown-reference', 'error', 'Reference to something that does not exist', 'A reference that resolves to nothing cannot be drawn or checked.', SCHEMA_SOURCE),
    rule('model/interface-provider', 'error', 'Interface used from a relationship that cannot provide it', INTERFACE_REFERENCE_RATIONALE, 'Clements2010; WirfsBrock2003'),
    rule('model/realizes-owner', 'error', 'Operation realizes a responsibility its provider does not own', INTERFACE_REFERENCE_RATIONALE, 'WirfsBrock2003'),
    rule('model/wrong-type-reference', 'error', 'Reference of the wrong type', 'An element reference must name the kind of element the field expects, for example a container to host.', BROWN),
    rule('model/containment-link', 'error', 'Relationship between nested elements', 'A relationship connects elements that do not contain each other; containment is already shown by the boundary.', BROWN),
    rule('model/refines-not-ancestor', 'error', 'Refinement of a responsibility the element does not nest inside', 'A responsibility can only refine one of an enclosing element, so the decomposition stays a tree.', 'Wirfs-Brock & McKean 2003'),
    rule('model/responsibility-owner', 'error', 'Requested responsibility not provided by the target', 'A collaborator asks its target for help the target provides.', 'Wirfs-Brock & McKean 2003'),
    rule('model/infrastructure-leaf', 'error', 'Infrastructure node with children', 'An infrastructure node is a leaf of the deployment tree.', BROWN),
    rule('view/unknown-selector', 'error', 'Selector names nothing', 'A view that cannot be resolved cannot be drawn.', BROWN,
      savedViewSelector('view/unknown-selector')),
    rule('view/wrong-scope-type', 'error', 'Selector names an element of the wrong type', 'Each view is drawn for one level, for example containers of a system.', BROWN,
      savedViewSelector('view/wrong-scope-type')),
    rule('view/mixed-abstraction', 'error', 'Custom view mixes abstraction levels', 'A view that shows an element and its ancestor shows the same thing twice at two levels.', BROWN,
      mixedAbstraction),
  ];

  // ---- Check context -------------------------------------------------------------------------

  /** A place in the YAML a finding points at; the first spot that resolves gives the diagnostic its range. */
  function spot(path, part = 'key') {
    return { path, part };
  }

  function finding(element, spots, message, { hint = null, severity = null } = {}) {
    return { element, spots, message, hint, severity };
  }

  /** A finding of an interface rule, which also names its interface, operation, and field (null where none applies). */
  function interfaceFinding(element, spots, message, { interfaceId = null, operation = null, field = null, hint = null, severity = null } = {}) {
    return Object.assign(finding(element, spots, message, { hint, severity }), { subject: { interface: interfaceId, operation, field } });
  }

  const elementSpots = (element) => [spot(element.path, 'key')];
  const fieldSpots = (element, field) => [spot(element.path.concat(field), 'value'), spot(element.path, 'key')];
  const relationshipSpots = (relationship) => [spot(relationship.path, 'pair'), spot(relationship.path, 'value')];
  const relationshipDescriptionSpots = (relationship) =>
    [spot(relationship.path.concat('description'), 'value'), spot(relationship.path, 'value')];

  function isBlank(text) {
    return text === null || text === undefined || text.trim() === '';
  }

  function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function normalized(text) {
    return (text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** The two elements a relationship connects. */
  function endsOf(model, relationship) {
    return { source: model.elements.get(relationship.sourceId), target: model.elements.get(relationship.targetId) };
  }

  /** The label of an element in messages. */
  function named(element) {
    return `${element.name} (${element.id})`;
  }

  /** The container an element lives in (itself for a container); the element itself above container level. */
  function liftToContainer(model, element) {
    for (let current = element; current; current = model.elements.get(current.parentId)) {
      if (current.type === 'container') return current;
    }
    return element;
  }

  function isCrossContainer(model, relationship) {
    const source = liftToContainer(model, model.elements.get(relationship.sourceId));
    const target = liftToContainer(model, model.elements.get(relationship.targetId));
    if (source.type === 'person' || source.id === target.id) return false;
    const involvesContainer = source.type === 'container' || target.type === 'container';
    const bothSoftware = ['container', 'system'].includes(source.type) && ['container', 'system'].includes(target.type);
    return involvesContainer && bothSoftware;
  }

  function elementsOfTypes(model, types) {
    return [...model.elements.values()].filter((element) => types.includes(element.type));
  }

  // ---- C4 rules ------------------------------------------------------------------------------

  function noDescription({ model }) {
    return elementsOfTypes(model, BOX_TYPES)
      .filter((element) => isBlank(element.description) && element.responsibilities.length === 0)
      .map((element) => finding(element.id, elementSpots(element),
        `${named(element)} has no description and no responsibilities, so its box would be empty`,
        { hint: 'Say in one sentence what it is or what it does.' }));
  }

  function sparseDescription({ model }) {
    return elementsOfTypes(model, BOX_TYPES)
      .filter((element) => !isBlank(element.description) && wordCount(element.description) < SPARSE_DESCRIPTION_WORDS)
      .map((element) => finding(element.id, fieldSpots(element, 'description'),
        `The description of ${named(element)} has fewer than ${SPARSE_DESCRIPTION_WORDS} words`,
        { hint: 'A short sentence that names its purpose tells a reader more than a label.' }));
  }

  function noTechnology({ model }) {
    return elementsOfTypes(model, ['container', 'component'])
      .filter((element) => isBlank(element.technology))
      .map((element) => finding(element.id, elementSpots(element), `${named(element)} does not name its technology`, {
        hint: 'Name the language, framework, or product it is built with, for example "Python, FastAPI".',
        severity: UNDESCRIBED_TECHNOLOGY_KINDS.includes(element.kind) ? 'info' : null,
      }));
  }

  function technologyTbd({ model }) {
    return elementsOfTypes(model, ['container', 'component'])
      .filter((element) => !isBlank(element.technology) && TBD_TECHNOLOGY.test(element.technology.trim()))
      .map((element) => finding(element.id, fieldSpots(element, 'technology'),
        `The technology of ${named(element)} is still to be decided`,
        { hint: 'Replace TBD with the technology once chosen, or record the options under choices.' }));
  }

  function vagueRelationship({ model }) {
    return model.relationships
      .filter((relationship) => !isBlank(relationship.description) && wordCount(relationship.description) <= VAGUE_RELATIONSHIP_WORDS)
      .map((relationship) => {
        const { source, target } = endsOf(model, relationship);
        return finding(relationship.sourceId, relationshipDescriptionSpots(relationship),
          `'${relationship.description.trim()}' could label any arrow. A reader cannot tell what ${source.name} asks of ${target.name}.`,
          { hint: "Write what is asked, ending with a word such as from, to, or through: 'requests tuition charges from'." });
      });
  }

  function duplicateRelationship({ model }) {
    const seen = new Set();
    const duplicates = [];
    model.relationships.forEach((relationship) => {
      const key = [relationship.sourceId, relationship.targetId, normalized(relationship.description)].join('\u0000');
      if (seen.has(key)) {
        duplicates.push(finding(relationship.sourceId, relationshipSpots(relationship),
          `${relationship.sourceId} to ${relationship.targetId} is described twice with the same description`,
          { hint: 'Remove one, or describe what differs between the two.' }));
      }
      seen.add(key);
    });
    return duplicates;
  }

  /**
   * The technology the interfaces a relationship uses agree on: its own uses, else those of the relationships it
   * summarizes (spec §4.6, §5.2 item 9); null when there are none, or they differ.
   */
  function usedInterfaceTechnology(model, relationship) {
    const uses = relationship.uses.length > 0 ? relationship.uses
      : projection.summarizedBy(model, relationship).flatMap((summarized) => summarized.uses);
    const technologies = new Set(uses.map((use) => model.interfaces.get(use.interfaceId).technology));
    return technologies.size === 1 ? [...technologies][0] : null;
  }

  function crossContainerTechnology({ model }) {
    return model.relationships
      .filter((relationship) => isBlank(relationship.technology) && isBlank(usedInterfaceTechnology(model, relationship)))
      .filter((relationship) => isCrossContainer(model, relationship))
      .map((relationship) => {
        const source = liftToContainer(model, model.elements.get(relationship.sourceId));
        const target = liftToContainer(model, model.elements.get(relationship.targetId));
        return finding(relationship.sourceId, relationshipSpots(relationship),
          `${source.name} and ${target.name} run as separate applications, but the relationship names no technology. ` +
          'A reader cannot tell how the request travels.',
          { hint: 'Name the protocol or format, such as JSON/HTTPS or SQL/TCP.' });
      });
  }

  function infrastructureContainer({ model }) {
    return elementsOfTypes(model, ['container'])
      .filter((element) => !isBlank(element.technology) && INFRASTRUCTURE_TECHNOLOGY.test(element.technology))
      .map((element) => finding(element.id, fieldSpots(element, 'technology'),
        `${element.technology.trim()} says where ${element.name} runs, not what it is built with. Where it runs belongs in a deployment view.`,
        { hint: 'Name the language and framework, or the database product; write TBD if the team has not chosen.' }));
  }

  function externalDecomposed({ model }) {
    return elementsOfTypes(model, ['system'])
      .filter((element) => element.external && element.childIds.length > 0)
      .map((element) => finding(element.id, elementSpots(element),
        `${named(element)} is an external system but has containers`,
        { hint: 'Your team does not design the inside of an external system; remove its containers or make it internal.' }));
  }

  function duplicateName({ model }) {
    const firstBySiblingName = new Map();
    const duplicates = [];
    model.elements.forEach((element) => {
      const key = `${element.parentId || ''}\u0000${normalized(element.name)}`;
      const first = firstBySiblingName.get(key);
      if (first) {
        duplicates.push(finding(element.id, elementSpots(element), `${named(element)} has the same name as its sibling ${first.id}`,
          { hint: 'Siblings need distinct names so a reader can tell the boxes apart.' }));
      } else {
        firstBySiblingName.set(key, element);
      }
    });
    return duplicates;
  }

  /** Ids of elements with a declared or derived relationship (an endpoint inside the element counts), and code links. */
  function connectedIds(model) {
    const connected = new Set();
    const addWithAncestors = (id) => {
      for (let element = model.elements.get(id); element; element = model.elements.get(element.parentId)) connected.add(element.id);
    };
    model.relationships.forEach((relationship) => {
      addWithAncestors(relationship.sourceId);
      addWithAncestors(relationship.targetId);
    });
    model.elements.forEach((element) => {
      if (!element.code) return;
      const targets = element.code.extends.concat(element.code.implements);
      if (targets.length === 0) return;
      connected.add(element.id);
      targets.forEach((id) => connected.add(id));
    });
    return connected;
  }

  function isolatedElement({ model }) {
    const connected = connectedIds(model);
    return [...model.elements.values()]
      .filter((element) => !connected.has(element.id))
      .map((element) => finding(element.id, elementSpots(element), `${named(element)} has no relationship to anything`, {
        hint: 'Add a collaborator that says whom it asks for help or who asks it.',
        severity: element.type === 'code' ? 'info' : null,
      }));
  }

  function genericName({ model }) {
    return [...model.elements.values()]
      .filter((element) => GENERIC_NAME.test(element.name.trim()))
      .map((element) => finding(element.id, elementSpots(element),
        `'${element.name.trim()}' could name a part of any system. A reader cannot tell what this one does.`,
        { hint: 'Name it after what it does for its users.' }));
  }

  function brokerHub({ model }) {
    return elementsOfTypes(model, ['container'])
      .filter((element) => !['queue', 'topic'].includes(element.kind))
      .filter((element) => BROKER_LOOKALIKE.test(`${element.name} ${element.technology || ''}`))
      .map((element) => finding(element.id, elementSpots(element), `${named(element)} looks like a message broker drawn as one box`,
        { hint: 'Model the queues and topics as containers of kind queue or topic, so each relationship shows what flows through which channel.' }));
  }

  // ---- View rules ----------------------------------------------------------------------------

  /** Where a view is declared, for the diagnostic range. */
  function viewLocation(model, view) {
    if (view.type === 'dynamic') return { element: null, path: model.scenarios.get(view.scopeId).path };
    if (view.type === 'deployment') return { element: null, path: model.environments.get(view.scopeId).path };
    if (view.type === 'custom') return { element: null, path: model.views.get(view.selector).path };
    if (view.type === 'landscape') return { element: null, path: null };
    return { element: view.scopeId, path: model.elements.get(view.scopeId).path };
  }

  function viewFinding(model, view, message, hint) {
    const { element, path } = viewLocation(model, view);
    return finding(element, path ? [spot(path, 'key')] : [], message, { hint });
  }

  function largeView({ model, thresholds, projectedViews }) {
    return projectedViews()
      .filter(({ projected }) => projected.elementCount > thresholds.viewElements)
      .map(({ view, projected }) => viewFinding(model, view,
        `${projected.title} shows ${projected.elementCount} elements; more than ${thresholds.viewElements} is hard to read`,
        'Show fewer elements, or split it into a custom view per concern.'));
  }

  function emptyView({ model, projectedViews }) {
    return projectedViews()
      .filter(({ view, projected }) => view.type !== 'landscape' && projected.elementCount === 0 && projected.diagnostics.length === 0)
      .map(({ view }) => viewFinding(model, view, `${view.title} shows no elements`,
        'Include elements in the view, or remove it.'));
  }

  /**
   * The check of one selector rule for saved views: a custom view whose `view` names nothing, or an element of the
   * wrong type, cannot be drawn, and projecting it yields the rule's diagnostic (spec §5.1, §7.2).
   */
  function savedViewSelector(ruleId) {
    return ({ model, projectedViews }) => projectedViews()
      .filter(({ view }) => view.type === 'custom')
      .flatMap(({ view, projected }) => projected.diagnostics.filter((diagnostic) => diagnostic.rule === ruleId).map((diagnostic) => {
        const { path } = model.views.get(view.selector);
        return finding(null, [spot(path.concat('view'), 'value'), spot(path, 'key')],
          `The view ${view.selector} cannot be drawn. ${diagnostic.message}`, { hint: diagnostic.hint });
      }));
  }

  /** The view that shows the parts of `element`, one level down (`components of api`), or null for a code element. */
  function partsViewOf(element) {
    const keyword = { system: 'containers', container: 'components', component: 'code' }[element.type];
    return keyword ? `${keyword} of ${element.id}` : null;
  }

  /**
   * `view/mixed-abstraction` (spec §7.2): a custom view whose `include` names an element while one of its ancestors
   * is drawn in the view as well, as a box of the base view or as another included element. Drawing both would show
   * the same part of the system at two levels, with the ancestor's relationships ending on a boundary around the
   * included element. A container of a system the base view does not draw may be included: it is shown inside a
   * labelled boundary of its system (spec §5.2).
   */
  function mixedAbstraction({ model }) {
    return [...model.views.values()].filter((view) => view.include.length > 0 && view.view).flatMap((view) => {
      const base = projection.projectView(model, view.view);
      if (base.notation !== 'c4' || base.diagnostics.length > 0) return [];
      const drawn = new Set(base.nodes.map((node) => node.id).concat(view.include));
      return view.include.flatMap((id) => {
        const included = model.elements.get(id);
        const ancestor = ancestorsOf(model, included).find((candidate) => drawn.has(candidate.id));
        if (!ancestor) return [];
        const partsView = partsViewOf(ancestor);
        return [finding(null, [spot(view.path.concat('include'), 'value'), spot(view.path, 'key')],
          `The view ${view.id} includes ${included.name}, a part of ${ancestor.name}, and shows ${ancestor.name} as well. ` +
          'A reader would see the same part of the system at two levels.',
          { hint: `Leave ${included.name} out of this view${partsView ? `, or show it in the view of ${ancestor.name}'s parts, ${partsView}` : ''}.` })];
      });
    });
  }

  /** The elements that contain `element`, nearest first. */
  function ancestorsOf(model, element) {
    const ancestors = [];
    for (let current = model.elements.get(element.parentId); current; current = model.elements.get(current.parentId)) ancestors.push(current);
    return ancestors;
  }

  function viewWithoutPurpose({ model }) {
    return [...model.views.values()]
      .filter((view) => isBlank(view.description))
      .map((view) => finding(null, [spot(view.path, 'key')], `The view ${view.id} has no description`,
        { hint: 'Say what question the view answers and for whom.' }));
  }

  // ---- Containment helpers -------------------------------------------------------------------

  /** True when `ancestorId` contains the element `id` at any depth. */
  function isAncestorOf(model, ancestorId, id) {
    for (let element = model.elements.get(id); element && element.parentId; element = model.elements.get(element.parentId)) {
      if (element.parentId === ancestorId) return true;
    }
    return false;
  }

  function isSameOrInside(model, id, ancestorId) {
    return id === ancestorId || isAncestorOf(model, ancestorId, id);
  }

  /** Two elements on one containment chain: the same element, or one inside the other. */
  function onSameChain(model, a, b) {
    return isSameOrInside(model, a, b) || isAncestorOf(model, a, b);
  }

  /** The element and its ancestors, innermost first. */
  function chainOf(model, id) {
    const chain = [];
    for (let element = model.elements.get(id); element; element = model.elements.get(element.parentId)) chain.push(element);
    return chain;
  }

  function nearestOfType(model, id, type) {
    return chainOf(model, id).find((element) => element.type === type) || null;
  }

  function isInsideExternalSystem(model, id) {
    const root = chainOf(model, id).pop();
    return Boolean(root) && root.type === 'system' && root.external;
  }

  // ---- Responsibility helpers ----------------------------------------------------------------

  function allResponsibilities(model) {
    return [...model.elements.values()].flatMap((element) => element.responsibilities);
  }

  const ownerOf = (model, responsibility) => model.elements.get(responsibility.ownerId);

  function responsibilitySpots(model, responsibility) {
    return [spot(responsibility.path, 'value')].concat(elementSpots(ownerOf(model, responsibility)));
  }

  function responsibilityFinding(model, responsibility, message, options) {
    return finding(responsibility.ownerId, responsibilitySpots(model, responsibility), message, options);
  }

  function hasKind(element, kind) {
    return element.responsibilities.some((responsibility) => responsibility.kind === kind);
  }

  /** Lowercase words of a text without punctuation, so "Seat  Holds," and "seat holds" compare equal. */
  function wordsOf(text) {
    return normalized(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  const phrase = (text) => wordsOf(text).join(' ');

  function mentions(text, factPhrase) {
    return ` ${phrase(text)} `.includes(` ${factPhrase} `);
  }

  /** Ids of responsibilities that a responsibility of one of their owner's descendants refines (spec §4.5). */
  function refinedResponsibilityIds(model) {
    const refined = new Set();
    allResponsibilities(model).forEach((child) => child.refines.forEach((id) => {
      const parent = model.responsibilityById.get(id);
      if (parent && isAncestorOf(model, parent.ownerId, child.ownerId)) refined.add(id);
    }));
    return refined;
  }

  // ---- RDD rules: responsibilities -----------------------------------------------------------

  function noResponsibility({ model }) {
    return elementsOfTypes(model, DESIGN_TYPES)
      .filter((element) => element.responsibilities.length === 0)
      .map((element) => finding(element.id, elementSpots(element), `${named(element)} has no responsibilities`, {
        hint: 'Say what it knows, does, or decides, starting each responsibility with KNOW, DO, or DECIDE.',
        severity: element.type === 'code' || element.external ? 'info' : null,
      }));
  }

  function untyped({ model }) {
    return allResponsibilities(model)
      .filter((responsibility) => responsibility.kind === null)
      .map((responsibility) => responsibilityFinding(model, responsibility,
        `"${responsibility.text}" of ${named(ownerOf(model, responsibility))} does not say whether it is KNOW, DO, or DECIDE`,
        { hint: 'Start it with KNOW for information it can provide, DO for work it performs, or DECIDE for a choice it makes.' }));
  }

  function readsAsCode(text) {
    return NON_OBLIGATION_PATTERNS.some((pattern) => pattern.test(text)) || (IDENTIFIER.test(text) && CODE_SHAPED.test(text));
  }

  function notAnObligation({ model }) {
    return allResponsibilities(model).flatMap((responsibility) => {
      const text = responsibility.text.trim();
      if (!readsAsCode(text)) return [];
      return [responsibilityFinding(model, responsibility,
        `'${text}' reads like a field, a method, or a screen step. A responsibility is a promise a reader can check.`,
        { hint: `Finish the sentence '${ownerOf(model, responsibility).name} promises to…' with KNOW, DO, or DECIDE.` })];
    });
  }

  function isVague(text) {
    const match = VAGUE_VERB.exec(text.trim());
    if (!match) return false;
    const nouns = text.trim().slice(match[0].length).split(/\s+/).filter((word) => word && !ARTICLES.has(word.toLowerCase()));
    return nouns.length <= VAGUE_MAX_NOUNS;
  }

  function vagueResponsibility({ model }) {
    return allResponsibilities(model)
      .filter((responsibility) => isVague(responsibility.text))
      .map((responsibility) => responsibilityFinding(model, responsibility,
        `"${responsibility.text.trim()}" of ${named(ownerOf(model, responsibility))} does not say what is done`,
        { hint: 'Name the outcome, for example what is decided, stored, or computed, and for whom.' }));
  }

  /** The element whose name a text starts with (after an optional "the"), preferring the longest name. */
  function subjectOf(elementsByLongestName, text) {
    const subject = text.trim().replace(/^the\s+/i, '');
    return elementsByLongestName.find((element) => subject.startsWith(`${element.name} `)) || null;
  }

  function ownerNamed({ model }) {
    const elementsByLongestName = [...model.elements.values()].sort((a, b) => b.name.length - a.name.length);
    return allResponsibilities(model).flatMap((responsibility) => {
      const subject = subjectOf(elementsByLongestName, responsibility.text);
      if (!subject || subject.id === responsibility.ownerId) return [];
      return [responsibilityFinding(model, responsibility,
        `"${responsibility.text.trim()}" names ${named(subject)} as its subject, but it is a responsibility of ${named(ownerOf(model, responsibility))}`,
        { hint: `Move it to ${subject.name}, or rewrite it as what ${ownerOf(model, responsibility).name} itself knows, does, or decides.` })];
    });
  }

  // ---- RDD rules: collaboration and authority ------------------------------------------------

  function noReason({ model }) {
    return model.relationships
      .filter((relationship) => isBlank(relationship.description))
      .map((relationship) => {
        const { source, target } = endsOf(model, relationship);
        return finding(relationship.sourceId, relationshipSpots(relationship),
          `${source.name}'s relationship to ${target.name} has no description. A reader cannot tell what ${source.name} asks for.`,
          { hint: `Read it aloud from ${source.name}: what does it ask ${target.name} for?` });
      });
  }

  /** Every `owns` item with its element, as a comparable phrase. */
  function ownedFacts(model) {
    return [...model.elements.values()].flatMap((element) => element.owns.map((item, index) => (
      { element, item, fact: phrase(item), path: element.path.concat('owns', index) })));
  }

  /** A data-store container that the owner (or a part of it) writes to holds the owner's facts in custody (spec §4.5). */
  function keepsCustodyFor(model, store, ownerId) {
    return store.type === 'container' && DATA_STORE_KINDS.includes(store.kind)
      && model.relationships.some((relationship) => isSameOrInside(model, relationship.sourceId, ownerId)
        && isSameOrInside(model, relationship.targetId, store.id));
  }

  function competesForAuthority(model, a, b) {
    return !onSameChain(model, a.id, b.id) && !keepsCustodyFor(model, a, b.id) && !keepsCustodyFor(model, b, a.id);
  }

  function duplicateOwnership(model, facts) {
    return facts.flatMap((later, index) => {
      const earlier = facts.slice(0, index)
        .find((candidate) => candidate.fact === later.fact && competesForAuthority(model, candidate.element, later.element));
      if (!earlier) return [];
      return [finding(later.element.id, [spot(later.path, 'value')].concat(elementSpots(later.element)),
        `${later.item} is owned by both ${earlier.element.name} and ${later.element.name}, which are not part of each other. ` +
        'A fact has one owner, its only writer.',
        { hint: `Which of the two writes ${later.item}? A container and its own component may both list it.` })];
    });
  }

  function knowledgeOfOwnedFacts(model, facts) {
    return allResponsibilities(model).filter((responsibility) => responsibility.kind === 'know').flatMap((responsibility) => {
      const knower = ownerOf(model, responsibility);
      const ownsItToo = (fact) => knower.owns.some((item) => phrase(item) === fact);
      const owned = facts.find(({ element, fact }) => mentions(responsibility.text, fact) && !ownsItToo(fact)
        && competesForAuthority(model, element, knower));
      if (!owned) return [];
      return [responsibilityFinding(model, responsibility,
        `${named(knower)} KNOWs "${owned.item}", which ${named(owned.element)} owns`,
        { hint: `Make sure it obtains the fact from ${owned.element.name} rather than keeping its own copy.`, severity: 'info' })];
    });
  }

  function duplicateAuthority({ model }) {
    const facts = ownedFacts(model);
    return duplicateOwnership(model, facts).concat(knowledgeOfOwnedFacts(model, facts));
  }

  /** The meaningful words of a decision, singular, for comparing two decisions. */
  function decisionKeywords(text) {
    return new Set(wordsOf(text)
      .filter((word) => word.length > 2 && !DECISION_STOPWORDS.has(word))
      .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)));
  }

  /** Jaccard similarity of two keyword sets. */
  function overlap(a, b) {
    const shared = [...a].filter((word) => b.has(word)).length;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 0 : shared / union;
  }

  function duplicateDecision({ model }) {
    const decisions = allResponsibilities(model).filter((responsibility) => responsibility.kind === 'decide')
      .map((responsibility) => ({ responsibility, keywords: decisionKeywords(responsibility.text) }));
    return decisions.flatMap((later, index) => {
      const earlier = decisions.slice(0, index).find((candidate) => overlap(candidate.keywords, later.keywords) >= NEAR_DUPLICATE_DECISION
        && !onSameChain(model, candidate.responsibility.ownerId, later.responsibility.ownerId));
      if (!earlier) return [];
      return [responsibilityFinding(model, later.responsibility,
        `${named(ownerOf(model, later.responsibility))} decides "${later.responsibility.text}", much like ` +
        `${named(ownerOf(model, earlier.responsibility))} deciding "${earlier.responsibility.text}"`,
        { hint: 'Give the decision to one element and let the other ask it, so the two cannot disagree.' })];
    });
  }

  // ---- RDD rules: size, names, control style -------------------------------------------------

  function godElement({ model, thresholds }) {
    const refined = refinedResponsibilityIds(model);
    return elementsOfTypes(model, ['container', 'component', 'code']).flatMap((element) => {
      const unrefined = element.responsibilities.filter((responsibility) => !refined.has(responsibility.id)).length;
      const collaborators = new Set(model.relationships.filter((relationship) => relationship.sourceId === element.id)
        .map((relationship) => relationship.targetId)).size;
      const excesses = [];
      if (unrefined > thresholds.unrefinedResponsibilities) {
        excesses.push(`${unrefined} unrefined responsibilities (more than ${thresholds.unrefinedResponsibilities})`);
      }
      if (collaborators > thresholds.collaborators) excesses.push(`${collaborators} collaborators (more than ${thresholds.collaborators})`);
      if (excesses.length === 0) return [];
      return [finding(element.id, elementSpots(element), `${named(element)} has ${excesses.join(' and ')}`, {
        hint: 'Split it into parts with one purpose each, and refine its responsibilities onto those parts.',
        severity: element.type === 'container' ? 'info' : null,
      })];
    });
  }

  function managerName({ model }) {
    return elementsOfTypes(model, DESIGN_TYPES)
      .filter((element) => !element.external && MANAGER_NAME.test(element.name.trim()))
      .map((element) => finding(element.id, elementSpots(element), `"${element.name}" names a kind of work, not a role in the domain`,
        { hint: 'Name it for what it is responsible for; a "manager" or "helper" tends to collect unrelated responsibilities.' }));
  }

  /** Software elements grouped by parent: the containers of a system, the components of a container, and so on. */
  function siblingGroups(model) {
    const groups = new Map();
    elementsOfTypes(model, DESIGN_TYPES).forEach((element) => {
      if (!groups.has(element.parentId)) groups.set(element.parentId, []);
      groups.get(element.parentId).push(element);
    });
    return [...groups.values()];
  }

  function centralizedControl({ model }) {
    return siblingGroups(model).filter((siblings) => siblings.length >= CENTRALIZED_CONTROL_SIBLINGS).flatMap((siblings) => {
      const deciders = siblings.filter((element) => hasKind(element, 'decide'));
      if (deciders.length !== 1) return [];
      const [center] = deciders;
      const onlyKnow = siblings.filter((element) => element !== center).every((element) => element.responsibilities.length > 0
        && element.responsibilities.every((responsibility) => responsibility.kind === 'know'));
      if (!onlyKnow) return [];
      return [finding(center.id, elementSpots(center), `${named(center)} makes every decision while its siblings only KNOW`,
        { hint: 'Centralized control is a choice. If rules keep accumulating here and the siblings hold the data each decision needs, consider delegating; for novice maintainers, a central element may be easier to follow.' })];
    });
  }

  function coordinatorDecides({ model }) {
    return elementsOfTypes(model, DESIGN_TYPES)
      .filter((element) => element.stereotypes.includes('coordinator'))
      .flatMap((element) => element.responsibilities)
      .filter((responsibility) => responsibility.kind === 'decide' && !SEQUENCING_DECISION.test(responsibility.text))
      .map((responsibility) => responsibilityFinding(model, responsibility,
        `Should the coordinator ${named(ownerOf(model, responsibility))} decide "${responsibility.text}"?`,
        { hint: 'A coordinator sequences work and delegates decisions; a service provider or controller could own this one.' }));
  }

  /** True when a relationship of the element (or a part of it) reaches outside its parent. */
  function crossesBoundary(model, element) {
    const outside = (id) => element.parentId === null || !isSameOrInside(model, id, element.parentId);
    return model.relationships.some((relationship) => (isSameOrInside(model, relationship.sourceId, element.id) && outside(relationship.targetId))
      || (isSameOrInside(model, relationship.targetId, element.id) && outside(relationship.sourceId)));
  }

  const STEREOTYPE_EXPECTATIONS = [
    { stereotype: 'controller', fits: (model, element) => hasKind(element, 'decide'),
      problem: 'is a controller but decides nothing', hint: 'Add the decisions it makes, or choose another stereotype.' },
    { stereotype: 'information_holder', fits: (model, element) => hasKind(element, 'know'),
      problem: 'is an information holder but knows nothing', hint: 'Add the information it provides, or choose another stereotype.' },
    { stereotype: 'interfacer', fits: crossesBoundary,
      problem: 'is an interfacer but crosses no boundary', hint: 'An interfacer connects its parent to something outside it; add that relationship, or choose another stereotype.' },
  ];

  function stereotypeMismatch({ model }) {
    return elementsOfTypes(model, DESIGN_TYPES).flatMap((element) => STEREOTYPE_EXPECTATIONS
      .filter(({ stereotype, fits }) => element.stereotypes.includes(stereotype) && !fits(model, element))
      .map(({ problem, hint }) => finding(element.id, elementSpots(element), `${named(element)} ${problem}`, { hint })));
  }

  function boundaryWithoutInterfacer({ model }) {
    const components = new Set(model.relationships
      .filter((relationship) => isInsideExternalSystem(model, relationship.targetId))
      .map((relationship) => nearestOfType(model, relationship.sourceId, 'component'))
      .filter((component) => component && !component.stereotypes.includes('interfacer')));
    return [...components].map((component) => finding(component.id, elementSpots(component),
      `${named(component)} calls an external system but is not marked as an interfacer`,
      { hint: 'Add the interfacer stereotype, or route the call through a component that translates to the external system.' }));
  }

  // ---- RDD rules: refinement, cycles, qualities, requirements -------------------------------

  function unrefined({ model }) {
    const refined = refinedResponsibilityIds(model);
    return [...model.elements.values()]
      .filter((element) => element.childIds.length > 0)
      .flatMap((element) => element.responsibilities.filter((responsibility) => !refined.has(responsibility.id)))
      .map((responsibility) => responsibilityFinding(model, responsibility,
        `"${responsibility.text}" of ${named(ownerOf(model, responsibility))} is not refined by any of its parts`,
        { hint: 'Give the part that helps realize it a responsibility whose refines names this one.' }));
  }

  /** A relationship lifted to the two siblings it connects: the children of the endpoints' nearest common ancestor. */
  function siblingEdge(model, relationship) {
    const sourceChain = chainOf(model, relationship.sourceId);
    const targetChain = chainOf(model, relationship.targetId);
    const targetIds = targetChain.map((element) => element.id);
    const common = sourceChain.findIndex((element) => targetIds.includes(element.id));
    if (common === -1) return { source: sourceChain[sourceChain.length - 1], target: targetChain[targetChain.length - 1] };
    return { source: sourceChain[common - 1], target: targetChain[targetIds.indexOf(sourceChain[common].id) - 1] };
  }

  function siblingGraph(model) {
    const graph = new Map();
    model.relationships.forEach((relationship) => {
      const { source, target } = siblingEdge(model, relationship);
      if (source.type === 'person' || target.type === 'person') return;
      if (!graph.has(source.id)) graph.set(source.id, new Set());
      graph.get(source.id).add(target.id);
    });
    return graph;
  }

  /** Ids reachable from `id` along one or more edges. */
  function reachableFrom(graph, id) {
    const reached = new Set();
    const pending = [...(graph.get(id) || [])];
    while (pending.length > 0) {
      const next = pending.pop();
      if (reached.has(next)) continue;
      reached.add(next);
      pending.push(...(graph.get(next) || []));
    }
    return reached;
  }

  /** The cycles of a graph (strongly connected sets of two or more ids), members in document order. */
  function cyclesOf(model, graph) {
    const reach = new Map([...model.elements.keys()].map((id) => [id, reachableFrom(graph, id)]));
    const assigned = new Set();
    const cycles = [];
    for (const id of model.elements.keys()) {
      if (assigned.has(id) || !reach.get(id).has(id)) continue;
      const members = [...model.elements.keys()].filter((other) => reach.get(id).has(other) && reach.get(other).has(id));
      members.forEach((member) => assigned.add(member));
      cycles.push(members.map((member) => model.elements.get(member)));
    }
    return cycles;
  }

  function collaborationCycle({ model }) {
    return cyclesOf(model, siblingGraph(model)).map((members) => finding(members[0].id, elementSpots(members[0]),
      `${members.map(named).join(', ')} depend on each other in a cycle`,
      { hint: 'Decide which of them depends on the other, or let one of them notify the other through an event.' }));
  }

  function isMeasurable(text) {
    return NUMBER_WITH_UNIT.test(text) || COMPARATOR.test(text);
  }

  function unmeasurableQuality({ model }) {
    return elementsOfTypes(model, DESIGN_TYPES).flatMap((element) => element.quality
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) => !isMeasurable(statement))
      .map(({ statement, index }) => finding(element.id, [spot(element.path.concat('quality', index), 'value')].concat(elementSpots(element)),
        `The quality "${statement}" of ${named(element)} cannot be measured`,
        { hint: 'State a number with its unit, such as "within 2 s for 95% of requests", or compare against something known.' })));
  }

  function uncoveredRequirement({ model }) {
    const referenced = new Set(allResponsibilities(model).flatMap((responsibility) => responsibility.requirements));
    return [...model.requirements.values()]
      .filter((requirement) => !referenced.has(requirement.id))
      .map((requirement) => finding(null, [spot(requirement.path, 'key')], `No responsibility traces to the requirement ${requirement.id}.`,
        { hint: `Which responsibility keeps the promise ${requirement.id} asks for? Add ${requirement.id} to its Requirements.` }));
  }

  // ---- Choices rules -------------------------------------------------------------------------

  /** Every place that records design choices: elements and collaborators, with the element diagnostics name. */
  function choiceSites(model) {
    return [...model.elements.values()].filter((element) => element.choices)
      .map((element) => ({ elementId: element.id, choices: element.choices, path: element.path.concat('choices') }))
      .concat(model.relationships.filter((relationship) => relationship.choices).map((relationship) => (
        { elementId: relationship.sourceId, choices: relationship.choices, path: relationship.path.concat('choices') })));
  }

  function patternEntries(model) {
    return choiceSites(model).flatMap((site) => site.choices.patterns.map((entry, index) => (
      { entry, elementId: site.elementId, path: site.path.concat('patterns', index) })));
  }

  const entrySpots = (path, field) => [spot(path.concat(field), 'value'), spot(path, 'value')];
  const compact = (text) => text.replace(/\s+/g, '').toLowerCase();

  function catalogPattern(name) {
    return Object.keys(schema.PATTERNS).find((pattern) => compact(pattern) === compact(name)) || null;
  }

  function catalogRole(pattern, role) {
    return schema.PATTERNS[pattern].roles.find((candidate) => compact(candidate) === compact(role)) || null;
  }

  function unknownPattern({ model }) {
    return patternEntries(model)
      .filter(({ entry }) => !isBlank(entry.pattern) && !catalogPattern(entry.pattern))
      .map(({ entry, elementId, path }) => finding(elementId, entrySpots(path, 'pattern'),
        `"${entry.pattern}" is not a pattern in the catalog`,
        { hint: `Known patterns: ${Object.keys(schema.PATTERNS).join(', ')}. An unlisted pattern is fine; its roles are not checked.` }));
  }

  function unknownStyle({ model }) {
    return choiceSites(model).flatMap((site) => site.choices.styles
      .map((style, index) => ({ style, index }))
      .filter(({ style }) => !schema.STYLES.some((known) => compact(known) === compact(style)))
      .map(({ style, index }) => finding(site.elementId, [spot(site.path.concat('styles', index), 'value')],
        `"${style}" is not an architectural style in the catalog`,
        { hint: `Known styles: ${schema.STYLES.join(', ')}. An unlisted style is fine.` })));
  }

  function unknownRole({ model }) {
    return patternEntries(model).flatMap(({ entry, elementId, path }) => {
      const pattern = isBlank(entry.pattern) ? null : catalogPattern(entry.pattern);
      if (!pattern || isBlank(entry.role) || catalogRole(pattern, entry.role)) return [];
      return [finding(elementId, entrySpots(path, 'role'), `${pattern} has no role "${entry.role}"`,
        { hint: `Its roles are ${schema.PATTERNS[pattern].roles.join(', ')}.` })];
    });
  }

  /** Pattern applications: entries of a catalog pattern that share an instance, in document order. */
  function patternApplications(model) {
    const applications = new Map();
    patternEntries(model).forEach((site) => {
      const pattern = isBlank(site.entry.pattern) ? null : catalogPattern(site.entry.pattern);
      if (!pattern || isBlank(site.entry.instance)) return;
      const key = `${pattern}\u0000${site.entry.instance.trim()}`;
      if (!applications.has(key)) applications.set(key, { pattern, instance: site.entry.instance.trim(), sites: [] });
      applications.get(key).sites.push(site);
    });
    return [...applications.values()];
  }

  function incompletePattern({ model }) {
    return patternApplications(model).flatMap(({ pattern, instance, sites }) => {
      const roles = new Set(sites.map(({ entry }) => (isBlank(entry.role) ? null : catalogRole(pattern, entry.role))));
      const missing = schema.PATTERNS[pattern].required.filter((role) => !roles.has(role));
      if (missing.length === 0) return [];
      const [first] = sites;
      return [finding(first.elementId, entrySpots(first.path, 'instance'),
        `The ${pattern} instance "${instance}" has no element in the role ${missing.join(', ')}`,
        { hint: `Mark the element that plays each missing role with pattern ${pattern}, its role, and instance ${instance}.` })];
    });
  }

  // ---- Cross-level rules ---------------------------------------------------------------------

  /** Invalid message steps of a scenario (spec §6.3); steps naming unknown elements are already model errors. */
  /** Invalid message steps between known elements, each with its 1-based number among the message steps in document order. */
  function invalidSteps(model, scenario) {
    let number = 0;
    const walk = (steps, statuses) => steps.flatMap((step, index) => {
      const status = statuses[index];
      if (step.kind === 'fragment') return step.branches.flatMap((branch, at) => walk(branch.steps, status.branches[at].steps));
      number += 1;
      const known = model.elements.has(step.from) && model.elements.has(step.to);
      return known && status.status === 'invalid' ? [{ step, number }] : [];
    });
    return walk(scenario.steps, projection.classifySteps(model, scenario.id));
  }

  function scenarioStep({ model }) {
    return [...model.scenarios.values()].flatMap((scenario) => invalidSteps(model, scenario).map(({ step, number }) => {
      const [source, target] = [model.elements.get(step.from), model.elements.get(step.to)];
      return finding(step.from, [spot(step.path, 'value')],
        `Step ${number}, ${source.name} to ${target.name}, follows no relationship in the model and answers no earlier request. ` +
        'A scenario can only use collaborations the design has.',
        { hint: `Does an earlier step ask ${source.name} for something it could answer?` });
    }));
  }

  function participantIds(steps) {
    return steps.flatMap((step) => (step.kind === 'fragment'
      ? step.branches.flatMap((branch) => participantIds(branch.steps))
      : [step.from, step.to]));
  }

  function scenarioLevels({ model }) {
    return [...model.scenarios.values()].flatMap((scenario) => {
      const participants = [...new Set(participantIds(scenario.steps))].filter((id) => model.elements.has(id));
      return participants.flatMap((id) => participants
        .filter((other) => isAncestorOf(model, other, id))
        .map((ancestorId) => finding(id, [spot(scenario.path, 'key')],
          `${scenario.title || scenario.id} shows both ${named(model.elements.get(id))} and ${named(model.elements.get(ancestorId))}, which contains it`,
          { hint: 'Tell a scenario at one level: use the containers of a system, or the components of a container, not both.' })));
    });
  }

  /** Relationships drawn to an unassigned boundary in a container or component view (spec §5.2 step 4). */
  function boundaryLandings(model, projectedViews) {
    const byId = new Map(model.relationships.map((relationship) => [relationship.id, relationship]));
    return projectedViews().filter(({ view }) => LEVEL_VIEW_TYPES.includes(view.type)).flatMap(({ view, projected }) => projected.edges
      .filter((edge) => edge.unassigned)
      .flatMap((edge) => edge.sources.map((id) => ({
        relationship: byId.get(id), boundary: model.elements.get(view.scopeId), incoming: edge.targetId === view.scopeId,
      }))));
  }

  /** `verb` is "receives" or "sends", as the part inside the boundary would. */
  function landingFinding(model, landing, verb) {
    const { source, target } = endsOf(model, landing.relationship);
    return finding(landing.boundary.id, relationshipSpots(landing.relationship),
      `${source.name} → ${target.name} reaches ${landing.boundary.name}, but no part inside it ${verb} it.`,
      { hint: `Choose which part ${verb} it.` });
  }

  function unreceived({ model, projectedViews }) {
    return boundaryLandings(model, projectedViews).filter((landing) => landing.incoming)
      .map((landing) => landingFinding(model, landing, 'receives'));
  }

  function unsent({ model, projectedViews }) {
    return boundaryLandings(model, projectedViews).filter((landing) => !landing.incoming)
      .map((landing) => landingFinding(model, landing, 'sends'));
  }

  /** Derived edges that merge several relationships, once each although several overview views draw them. */
  function mergedDerivedEdges(projectedViews) {
    const byId = new Map();
    projectedViews().filter(({ view }) => OVERVIEW_VIEW_TYPES.includes(view.type)).forEach(({ projected }) => projected.edges
      .filter((edge) => edge.derived && edge.sources.length >= 2 && !byId.has(edge.id))
      .forEach((edge) => byId.set(edge.id, edge)));
    return [...byId.values()];
  }

  function unsummarized({ model, projectedViews }) {
    return mergedDerivedEdges(projectedViews).map((edge) => {
      const source = model.elements.get(edge.sourceId);
      return finding(source.id, elementSpots(source),
        `${edge.sources.length} relationships from inside ${edge.sourceId} to ${edge.targetId} are drawn as one edge without a summary`,
        { hint: `Declare a relationship from ${edge.sourceId} to ${edge.targetId} whose description sums them up.` });
    });
  }

  function summaryCopy({ model }) {
    return model.relationships.filter((summary) => !isBlank(summary.description)).flatMap((summary) => {
      const children = projection.summarizedBy(model, summary);
      if (children.length !== 1 || normalized(children[0].description) !== normalized(summary.description)) return [];
      return [finding(summary.sourceId, relationshipSpots(summary),
        `The relationship ${summary.sourceId} to ${summary.targetId} repeats its only detail, ${children[0].sourceId} to ${children[0].targetId}`,
        { hint: 'Remove the summary, which the view draws anyway, or describe the collaboration at its own level.' })];
    });
  }

  function undeployed({ model }) {
    return [...model.environments.values()].flatMap((environment) => {
      const hosted = new Set([...environment.nodes.values()].flatMap((node) => node.hosts));
      return elementsOfTypes(model, ['container'])
        .filter((container) => !hosted.has(container.id) && model.elements.get(container.parentId).childIds.some((id) => hosted.has(id)))
        .map((container) => finding(container.id, elementSpots(container),
          `${named(container)} is not deployed in ${environment.name}, which hosts other containers of its system`,
          { hint: `Add ${container.id} to the hosts of a node in ${environment.name}, or say why it does not run there.` }));
    });
  }

  // ---- Interface helpers (spec §4.11) --------------------------------------------------------

  /** Uses that make an interface used (spec §4.11 counting); a `channel` use only declares the queue or topic. */
  const COUNTED_USE_KINDS = ['request', 'emit', 'broker-peer'];
  const ASYNCHRONOUS_STYLES = ['message', 'event', 'stream'];
  const SYNCHRONOUS_CONNECTORS = ['call', 'shared-data'];
  const STYLE_PHRASES = {
    rest: 'a REST', rpc: 'an RPC', graphql: 'a GraphQL', soap: 'a SOAP', message: 'a message', event: 'an event',
    stream: 'a stream', library: 'a library', file: 'a file',
  };
  /** Words that name a unit inside a field's meaning, so the hint can ask to move it into Unit. */
  const UNIT_IN_MEANING = /%|\b(?:cents?|dollars?|euros?|pence|percent|(?:milli|micro|nano)?seconds?|minutes?|hours?|days?|weeks?|months?|years?|(?:kilo|milli)?(?:grams?|met(?:er|re)s?)|kg|km|miles?|inch(?:es)?|feet|pounds?|(?:kilo|mega|giga)?bytes?|items?)\b/i;
  const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  const isMapValue = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const hasKey = (map, key) => Object.prototype.hasOwnProperty.call(map, key);

  /** True when the model opts in to interface descriptions: a full-form interface, or a `uses` entry (spec §7.2). */
  function interfacesActive(model) {
    const stepUses = (steps) => steps.some((step) => (step.kind === 'fragment'
      ? step.branches.some((branch) => stepUses(branch.steps))
      : Boolean(step.uses)));
    return [...model.interfaces.values()].some((declared) => !declared.shorthand)
      || model.relationships.some((relationship) => relationship.uses.length > 0)
      || [...model.scenarios.values()].some((scenario) => stepUses(scenario.steps));
  }

  function fullFormInterfaces(model) {
    return [...model.interfaces.values()].filter((declared) => !declared.shorthand);
  }

  const providerOf = (model, declared) => model.elements.get(declared.providerId);
  const interfaceSpots = (declared) => [spot(declared.path, 'key')];
  // A shorthand operation is a list item, which has no key.
  const operationSpots = (operation) => [spot(operation.path, 'key'), spot(operation.path, 'value')];
  const interfaceFieldSpots = (field) => [spot(field.path, 'key')];
  const syntaxSpots = (operation) => [spot(operation.path.concat('syntax'), 'value')].concat(operationSpots(operation));

  /** A finding about an interface (`operation` and `field` when one applies), reported on its provider. */
  function onInterface(declared, spots, message, options = {}) {
    return interfaceFinding(declared.providerId, spots, message, Object.assign({ interfaceId: declared.id }, options));
  }

  /** Each operation's input and output, in document order. */
  function operationSides(declared) {
    return declared.operations.flatMap((operation) => ['input', 'output']
      .filter((side) => operation[side] !== null)
      .map((side) => ({ operation, side, use: operation[side] })));
  }

  /**
   * Every field of an interface with the label messages show: the inline fields of each operation's input and output,
   * then the fields of its types (`Charge.status`).
   */
  function interfaceFields(declared) {
    const inline = operationSides(declared).filter(({ use }) => use.fields).flatMap(({ operation, side, use }) => use.fields
      .map((field) => ({ field, operation: operation.id, label: `${field.name} (${side} of ${operation.id})` })));
    const named = [...declared.types.values()].flatMap((type) => type.fields
      .map((field) => ({ field, operation: null, label: `${type.name}.${field.name}` })));
    return inline.concat(named);
  }

  /** Every type reference of an interface (input and output types, then field types), with where it is written. */
  function typeReferences(declared) {
    const written = operationSides(declared).filter(({ use }) => use.type).map(({ operation, side, use }) => (
      { ref: use.type, operation: operation.id, field: null, spots: [spot(operation.path.concat(side), 'value')] }));
    const ofFields = interfaceFields(declared).filter(({ field }) => field.type !== null).map(({ field, operation }) => (
      { ref: field.type, operation, field: field.name, spots: [spot(field.path.concat('type'), 'value'), spot(field.path, 'value')] }));
    return written.concat(ofFields);
  }

  /** The uses that make interfaces used, each with its relationship and the element that uses the interface. */
  function countedUses(model) {
    return model.relationships.flatMap((relationship) => relationship.uses
      .filter((use) => COUNTED_USE_KINDS.includes(use.kind))
      .map((use) => ({ relationship, use, userId: use.kind === 'emit' ? relationship.targetId : relationship.sourceId })));
  }

  function usesOf(model, declared) {
    return countedUses(model).filter(({ use }) => use.interfaceId === declared.id);
  }

  /** The operations a set of uses reaches: every operation when one use names the whole interface. */
  function usedOperationIds(declared, uses) {
    if (uses.some(({ use }) => use.operationId === null)) return new Set(declared.operations.map((operation) => operation.id));
    return new Set(uses.map(({ use }) => use.operationId));
  }

  const outermostOf = (model, id) => chainOf(model, id).pop();

  /** The container an element runs in, or its outermost element (a person or a system) above container level. */
  function runsIn(model, id) {
    return nearestOfType(model, id, 'container') || outermostOf(model, id);
  }

  /** The boundary between two elements: 'system', 'container', or null when they run in one container. */
  function boundaryBetween(model, a, b) {
    if (outermostOf(model, a).id !== outermostOf(model, b).id) return 'system';
    return runsIn(model, a).id === runsIn(model, b).id ? null : 'container';
  }

  /** The uses of an interface by an element on the other side of a container or system boundary. */
  function crossingUses(model, declared) {
    return usesOf(model, declared).filter(({ userId }) => boundaryBetween(model, userId, declared.providerId) !== null);
  }

  /** Ids of the responsibilities that a responsibility refines, at any depth. */
  function refinedByIds(model, id) {
    const refined = new Set();
    const pending = [id];
    while (pending.length > 0) {
      const responsibility = model.responsibilityById.get(pending.pop());
      (responsibility ? responsibility.refines : []).filter((parent) => !refined.has(parent)).forEach((parent) => {
        refined.add(parent);
        pending.push(parent);
      });
    }
    return refined;
  }

  /** "A", "A and B", or "A, B, and C". */
  function listed(names) {
    if (names.length <= 2) return names.join(' and ');
    return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  }

  // ---- Interface rules: syntactic view -------------------------------------------------------

  function noSyntax({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => {
      if (declared.operations.length === 0 && declared.types.size === 0) {
        return [onInterface(declared, interfaceSpots(declared), `${declared.name} has no operations and no types.`,
          { hint: 'Add an operation a client can call, or the types of the document it exchanges.' })];
      }
      return declared.operations.filter((operation) => isBlank(operation.syntax)).map((operation) => onInterface(declared,
        operationSpots(operation), `${operation.id} has no syntax line. A client cannot call an operation it cannot write down.`,
        { operation: operation.id, hint: 'Write the call as a client would, such as GET /books/{isbn} or reserve(book) -> Loan.' }));
    });
  }

  function untypedField({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => interfaceFields(declared)
      .filter(({ field }) => field.type === null)
      .map(({ field, operation, label }) => onInterface(declared, interfaceFieldSpots(field),
        `${label} has no Type. Without one, a client cannot tell a number from text.`,
        { operation, field: field.name, hint: 'Choose a primitive (string, integer, number, boolean, datetime, …) or a type of this interface.' })));
  }

  function undefinedType({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => typeReferences(declared)
      .filter(({ ref }) => ref.invalid || !ref.defined)
      .map(({ ref, operation, field, spots }) => (ref.invalid
        ? onInterface(declared, spots, `'${ref.text}' is not a type.`,
          { operation, field, hint: 'Use a primitive or a type of this interface; write a list as string[].' })
        : onInterface(declared, spots, `${ref.name} is used as a type but not described. A client needs its fields to build or read it.`,
          { operation, field, hint: `Add ${ref.name} under Types, or use a primitive such as string.` }))));
  }

  function typeSpelling({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => {
      const reported = new Set();
      return typeReferences(declared).filter(({ ref }) => !ref.invalid && ref.spelling !== null).flatMap(({ ref, operation, field, spots }) => {
        if (reported.has(ref.spelling)) return [];
        reported.add(ref.spelling);
        return [onInterface(declared, spots, `${ref.spelling} is written ${ref.canonical} in interface descriptions; both mean ` +
          'the same, and the editor writes the standard form.', { operation, field })];
      });
    });
  }

  // ---- Interface rules: semantic view --------------------------------------------------------

  function noPurpose({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => {
      const hint = 'Say when a client calls it and what the provider then does.';
      if (declared.documentFormat) {
        return isBlank(declared.description) ? [onInterface(declared, interfaceSpots(declared),
          `${declared.name} has no Purpose. A client cannot tell whether the document fits its need.`,
          { hint: 'Say in its description when a client exchanges the document and what it records.' })] : [];
      }
      return declared.operations.filter((operation) => isBlank(operation.purpose)).map((operation) => onInterface(declared,
        operationSpots(operation), `${operation.id} has no Purpose. A client cannot tell whether the operation fits its need.`,
        { operation: operation.id, hint }));
    });
  }

  function noErrors({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => {
      const warns = schema.ERROR_WARNING_STYLES.includes(declared.style);
      const hint = schema.EMITTER_STYLES.includes(declared.style)
        ? 'What can a subscriber not rely on: can it receive this twice, out of order, or not at all?'
        : 'What happens when the caller is not allowed, sends something invalid, or calls too often?';
      return declared.operations.filter((operation) => operation.errors.length + declared.errors.length === 0)
        .map((operation) => onInterface(declared, operationSpots(operation), `${operation.id} lists no errors. A client built ` +
          'by another team must know what can go wrong and what to do then.', { operation: operation.id, hint, severity: warns ? null : 'info' }));
    });
  }

  /** A field whose values map gives every value a meaning: an enumerated code, which needs no unit. */
  function isEnumeratedCode(field) {
    return field.valuesForm === 'map' && field.values.length > 0 && field.values.every((entry) => !isBlank(entry.meaning));
  }

  function nameWords(field) {
    return schema.splitWords(field.name);
  }

  function noUnit({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => interfaceFields(declared)
      .filter(({ field }) => field.type && !field.type.invalid && isBlank(field.unit))
      .flatMap(({ field, operation, label }) => {
        const where = { operation, field: field.name };
        if (schema.NUMERIC_TYPES.includes(field.type.name)) {
          if (isEnumeratedCode(field) || schema.IDENTIFIER_FIELD_PATTERN.test(field.name)) return [];
          const hint = !isBlank(field.meaning) && UNIT_IN_MEANING.test(field.meaning)
            ? 'The meaning mentions a unit; put it in Unit so clients and checks can find it.'
            : 'Set Unit to what a value of 1 means (seconds, cents, kilograms, items).';
          return [onInterface(declared, interfaceFieldSpots(field),
            `${label} is a number with no Unit. Two teams can read the same number differently.`, Object.assign({ hint }, where))];
        }
        const suggestsQuantity = field.type.name === 'string' && nameWords(field).some((word) => schema.QUANTITY_WORDS.includes(word));
        return suggestsQuantity ? [onInterface(declared, interfaceFieldSpots(field), `${label} is text, but its name suggests a quantity. ` +
          'If it carries an amount, state its unit and what it includes (tax, fees), or make it a number with a Unit.',
        Object.assign({ severity: 'info' }, where))] : [];
      }));
  }

  function suggestsDate(field) {
    const words = nameWords(field);
    return words.some((word) => schema.DATE_WORDS.includes(word)) || schema.DATE_SUFFIX_WORDS.includes(words[words.length - 1]);
  }

  function noFormat({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => interfaceFields(declared)
      .filter(({ field }) => field.type && !field.type.invalid && isBlank(field.format))
      .flatMap(({ field, operation, label }) => {
        const where = { operation, field: field.name };
        if (schema.TEMPORAL_TYPES.includes(field.type.name)) {
          return [onInterface(declared, interfaceFieldSpots(field), `${label} is a date or time with no Format. Which comes first, day or ` +
            'month, and in which time zone?', Object.assign({ hint: 'State the order of the parts and the time zone, for example ' +
            'YYYY-MM-DD in local time of the venue.' }, where))];
        }
        return field.type.name === 'string' && suggestsDate(field) ? [onInterface(declared, interfaceFieldSpots(field),
          `${label} is text, but its name suggests a date or time. State its Format.`, Object.assign({ severity: 'info' }, where))] : [];
      }));
  }

  // ---- Interface rules: examples -------------------------------------------------------------

  /** The problems of one example value against a type reference: list items, local types, values, numbers. */
  function referenceProblems(declared, ref, value, label, field = null) {
    if (ref.invalid || !ref.defined) return [];
    const items = ref.list ? (Array.isArray(value) ? value : []) : [value];
    return items.flatMap((item) => itemProblems(declared, ref, item, label, field));
  }

  function itemProblems(declared, ref, item, label, field) {
    if (!ref.primitive) return fieldMapProblems(declared, declared.types.get(ref.name).fields, ref.name, item);
    if (typeof item !== 'string') return [];
    if (field && field.values && !field.values.some((entry) => entry.value === item)) return [`${label}: ${item} is not one of its values`];
    if (schema.NUMERIC_TYPES.includes(ref.name) && !NUMERIC_TEXT.test(item.trim())) return [`${label}: ${item} is not a number`];
    return [];
  }

  /** The problems of an example map against fields: unknown keys, missing required fields, and wrong field values. */
  function fieldMapProblems(declared, fields, owner, value) {
    if (!isMapValue(value)) return [];
    const names = new Set(fields.map((field) => field.name));
    return Object.keys(value).filter((key) => !names.has(key)).map((key) => `${key} is not a field of ${owner}`)
      .concat(fields.filter((field) => field.required && !hasKey(value, field.name))
        .map((field) => `the required field ${field.name} is missing`))
      .concat(fields.filter((field) => field.type && hasKey(value, field.name) && value[field.name] !== null)
        .flatMap((field) => referenceProblems(declared, field.type, value[field.name], field.name, field)));
  }

  function sideProblems(declared, operation, side, value) {
    const use = operation[side];
    if (use === null || value === null) return [];
    return use.fields ? fieldMapProblems(declared, use.fields, `the ${side}`, value) : referenceProblems(declared, use.type, value, side);
  }

  function exampleMismatch({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => declared.operations.flatMap((operation) => operation.examples
      .map((example, index) => ({ example, number: index + 1,
        problems: sideProblems(declared, operation, 'input', example.input).concat(sideProblems(declared, operation, 'output', example.output)) }))
      .filter(({ problems }) => problems.length > 0)
      .map(({ example, number, problems }) => onInterface(declared, [spot(example.path, 'value')],
        `Example ${number} of ${operation.id} does not match its types: ${problems.join('; ')}. An example that contradicts ` +
        'the syntax misleads every client that copies it.', { operation: operation.id }))));
  }

  // ---- Interface rules: responsibilities and boundaries --------------------------------------

  function realizesInternal({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => {
      const provider = providerOf(model, declared);
      const promised = new Set(provider.responsibilities.map((responsibility) => responsibility.id).filter((id) => id !== null));
      return declared.operations.flatMap((operation) => operation.realizes.flatMap((id, index) => {
        const responsibility = model.responsibilityById.get(id);
        if (!responsibility || !isAncestorOf(model, provider.id, responsibility.ownerId)) return [];
        if ([...refinedByIds(model, id)].some((refined) => promised.has(refined))) return [];
        const owner = ownerOf(model, responsibility);
        const realizes = operation.path.concat('realizes');
        return [onInterface(declared, [spot(realizes.concat(index), 'value'), spot(realizes, 'value')],
          `${operation.id} is linked to '${responsibility.text}', an obligation private to ${owner.name}. Clients rely on what ` +
          `${provider.name} promises, not on how its parts divide the work.`, { operation: operation.id,
            hint: `Link the operation to the responsibility of ${provider.name} that this one helps realize, or remove the link.` })];
      }));
    });
  }

  /** An interface a client reaches only inside its provider's container: a library, or an unset style on a component. */
  function isInProcess(model, declared) {
    return declared.style === 'library' || (declared.style === null && providerOf(model, declared).type === 'component');
  }

  /** Whether `sourceId` reaches the in-process interface `declared` from another container, which the interface cannot serve. */
  function isInProcessAcrossBoundary(model, declared, sourceId) {
    return isInProcess(model, declared) && runsIn(model, sourceId).id !== runsIn(model, declared.providerId).id;
  }

  function inProcessAcrossBoundary({ model }) {
    return model.relationships.flatMap((relationship) => relationship.uses
      .filter((use) => use.kind === 'request')
      .map((use) => ({ use, declared: model.interfaces.get(use.interfaceId) }))
      .filter(({ declared }) => isInProcessAcrossBoundary(model, declared, relationship.sourceId))
      .map(({ use, declared }) => {
        const source = model.elements.get(relationship.sourceId);
        return interfaceFinding(source.id, [spot(use.path, 'value')].concat(relationshipSpots(relationship)),
          `${declared.name} is an in-process interface of ${providerOf(model, declared).name}, and ${source.name} runs in another ` +
          'container. A component is not separately deployable: a client elsewhere reaches it through an interface offered over the network.',
          { interfaceId: declared.id, operation: use.operationId,
            hint: 'Use the interface of the container the request enters, or set the remote style the component exposes.' });
      }));
  }

  /** True when one of two responsibilities is the other, or refines it at any depth. */
  function onOneRefinementChain(model, a, b) {
    return a === b || refinedByIds(model, a).has(b) || refinedByIds(model, b).has(a);
  }

  function requestedNotAdvertised({ model }) {
    return model.relationships.filter((relationship) => model.responsibilityById.has(relationship.responsibility)).flatMap((relationship) => {
      const operationUses = relationship.uses.filter((use) => use.operationId !== null);
      if (operationUses.length === 0) return [];
      const realized = operationUses.flatMap((use) => model.interfaces.get(use.interfaceId).operations
        .find((operation) => operation.id === use.operationId).realizes);
      if (realized.some((id) => onOneRefinementChain(model, id, relationship.responsibility))) return [];
      const [first] = operationUses;
      return [interfaceFinding(relationship.sourceId,
        [spot(relationship.path.concat('responsibility'), 'value')].concat(relationshipSpots(relationship)),
        `This relationship asks ${model.elements.get(relationship.targetId).name} for ` +
        `'${model.responsibilityById.get(relationship.responsibility).text}', but the operation it uses is linked to other ` +
        "responsibilities. Does the client call the right operation, or is the operation's link incomplete?",
        { interfaceId: first.interfaceId, operation: first.operationId })];
    });
  }

  // ---- Interface rules: formalize across boundaries ------------------------------------------

  function syntaxOnly({ model }) {
    return [...model.interfaces.values()].filter((declared) => declared.shorthand).flatMap((declared) => {
      const crossing = crossingUses(model, declared);
      if (crossing.length === 0) return [];
      const [{ userId }] = crossing;
      return [onInterface(declared, interfaceSpots(declared), `${declared.name} lists only call syntax, and ` +
        `${model.elements.get(userId).name} uses it across a ${boundaryBetween(model, userId, declared.providerId)} boundary. ` +
        'An independently built client also needs the purpose, the errors, and what the data means.', { hint: 'Describe it fully.' })];
    });
  }

  function noMeaning({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => {
      const crossesBoundary = crossingUses(model, declared).length > 0;
      return interfaceFields(declared).flatMap(({ field, operation, label }) => {
        const where = { operation, field: field.name };
        const missing = isBlank(field.meaning) ? [onInterface(declared, interfaceFieldSpots(field),
          `${label} has no Meaning. A team that never spoke to you will guess.`,
          Object.assign({ hint: 'What does this field identify or measure, and for whom?' }, where))] : [];
        const valuesWithout = crossesBoundary && field.values && field.values.some((entry) => isBlank(entry.meaning))
          ? [onInterface(declared, interfaceFieldSpots(field), `Some values of ${label} have no meaning.`,
            Object.assign({ hint: 'What does each value tell the client?' }, where))] : [];
        return missing.concat(valuesWithout);
      });
    });
  }

  function noExample({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => {
      const used = usedOperationIds(declared, crossingUses(model, declared));
      return declared.operations.filter((operation) => used.has(operation.id) && operation.examples.length === 0)
        .map((operation) => onInterface(declared, operationSpots(operation),
          `${operation.id} has no example. One request with its response shows a client more than a page of rules.`,
          { operation: operation.id }));
    });
  }

  function unrealized({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => {
      const provider = providerOf(model, declared);
      if (isInsideExternalSystem(model, provider.id) || provider.responsibilities.length === 0) return [];
      return declared.operations.filter((operation) => operation.realizes.length === 0).map((operation) => onInterface(declared,
        operationSpots(operation), `${operation.id} is not linked to a responsibility of ${provider.name}. Which obligation ` +
        'does a client reach through it?', { operation: operation.id }));
    });
  }

  /** The names an interface shows clients: syntax lines, type names, and field names, with where they are written. */
  function clientVisibleNames(declared) {
    const syntaxes = declared.operations.filter((operation) => !isBlank(operation.syntax))
      .map((operation) => ({ name: operation.syntax, spots: syntaxSpots(operation), operation: operation.id, field: null }));
    const types = [...declared.types.values()].map((type) => ({ name: type.name, spots: [spot(type.path, 'key')], operation: null, field: null }));
    const fields = interfaceFields(declared)
      .map(({ field, operation }) => ({ name: field.name, spots: interfaceFieldSpots(field), operation, field: field.name }));
    return syntaxes.concat(types, fields);
  }

  function leaksImplementation({ model }) {
    return [...model.interfaces.values()].flatMap((declared) => clientVisibleNames(declared)
      .filter(({ name }) => schema.leakWords(name).length > 0)
      .map(({ name, spots, operation, field }) => onInterface(declared, spots, `Does '${name}' tell clients how ` +
        `${providerOf(model, declared).name} stores or computes data? Names of tables, keys, and locks tie clients to the implementation.`,
      { operation, field })));
  }

  function conflictingVocabulary({ model }) {
    const shared = new Map(model.vocabulary.map((entry) => [normalized(entry.term), entry]));
    const earlier = [];
    return [...model.interfaces.values()].flatMap((declared) => declared.vocabulary.flatMap((entry) => {
      const term = normalized(entry.term);
      const differs = (other) => normalized(other.meaning) !== normalized(entry.meaning);
      const sharedEntry = shared.get(term);
      const previous = earlier.find((other) => other.term === term && differs(other.entry));
      earlier.push({ term, entry, declared });
      const conflict = sharedEntry && differs(sharedEntry) ? `${declared.name} and the shared vocabulary`
        : previous ? `${previous.declared.name} and ${declared.name}` : null;
      return conflict ? [onInterface(declared, [spot(entry.path, 'key')], `'${entry.term.trim()}' means different things in ` +
        `${conflict}. Two systems that read one word differently do not interoperate.`,
      { hint: 'Agree on one meaning in the shared vocabulary, or use two terms.' })] : [];
    }));
  }

  function disagreesOnSynchrony(relationship, style) {
    return (relationship.async && schema.SYNC_STYLES.includes(style))
      || (SYNCHRONOUS_CONNECTORS.includes(relationship.connector) && ASYNCHRONOUS_STYLES.includes(style));
  }

  function styleMismatch({ model }) {
    return model.relationships.flatMap((relationship) => [...new Set(relationship.uses.map((use) => use.interfaceId))]
      .map((id) => model.interfaces.get(id))
      .filter((declared) => disagreesOnSynchrony(relationship, declared.style))
      .map((declared) => interfaceFinding(relationship.sourceId,
        [spot(relationship.path.concat('connector'), 'value')].concat(relationshipSpots(relationship)),
        `The relationship is drawn as ${relationship.connector} but uses ${declared.name}, ${STYLE_PHRASES[declared.style]} ` +
        'interface. Is the call synchronous or not?', { interfaceId: declared.id })));
  }

  /** True when the relationship, one it summarizes, or one that summarizes it names an interface. */
  function namesAnInterface(model, relationship) {
    const hasUses = (candidate) => candidate.uses.length > 0;
    return hasUses(relationship) || projection.summarizedBy(model, relationship).some(hasUses)
      || model.relationships.some((summary) => hasUses(summary) && projection.summarizedBy(model, summary).includes(relationship));
  }

  function joinsTwoSoftwareSystems(model, relationship) {
    const [source, target] = [relationship.sourceId, relationship.targetId].map((id) => outermostOf(model, id));
    return source.type === 'system' && target.type === 'system' && source.id !== target.id;
  }

  function unspecifiedUse({ model }) {
    return model.relationships
      .filter((relationship) => joinsTwoSoftwareSystems(model, relationship) && !namesAnInterface(model, relationship))
      .map((relationship) => {
        const { source, target } = endsOf(model, relationship);
        const offered = [...model.interfaces.values()].filter((declared) => isSameOrInside(model, declared.providerId, target.id))
          .map((declared) => declared.name);
        return interfaceFinding(source.id, relationshipSpots(relationship), `${source.name} depends on ${target.name}, another ` +
          'software system, but names no interface. Which interface does it use?', { hint: offered.length > 0
          ? `${target.name} offers ${listed(offered)}.`
          : `${target.name} describes no interface yet; describe the one this team relies on.` });
      });
  }

  /** A provider that receives a relationship without `uses` from a person or another software system (spec §7.2). */
  function isEntryPoint(model, declared) {
    const providerSystem = outermostOf(model, declared.providerId);
    const fromOutside = (source) => source.type === 'person' || source.id !== providerSystem.id;
    return model.relationships.some((relationship) => relationship.uses.length === 0
      && isSameOrInside(model, relationship.targetId, declared.providerId)
      && fromOutside(outermostOf(model, relationship.sourceId)));
  }

  function unused({ model }) {
    return [...model.interfaces.values()]
      .filter((declared) => usesOf(model, declared).length === 0 && !isEntryPoint(model, declared))
      .map((declared) => onInterface(declared, interfaceSpots(declared),
        `No relationship uses ${declared.name}. Is it an entry point for clients outside this model, or can it go?`));
  }

  function unusedOperation({ model }) {
    return [...model.interfaces.values()].flatMap((declared) => {
      const uses = usesOf(model, declared);
      if (uses.length === 0) return [];
      const used = usedOperationIds(declared, uses);
      return declared.operations.filter((operation) => !used.has(operation.id)).map((operation) => onInterface(declared,
        operationSpots(operation), `No client uses ${operation.id}. Does any client need it? An interface that offers only ` +
        'what clients use is easier to keep stable.', { operation: operation.id }));
    });
  }

  function noVersion({ model }) {
    return fullFormInterfaces(model)
      .filter((declared) => isBlank(declared.version) && (isInsideExternalSystem(model, declared.providerId)
        || crossingUses(model, declared).some(({ userId }) => boundaryBetween(model, userId, declared.providerId) === 'system')))
      .map((declared) => onInterface(declared, interfaceSpots(declared), `${declared.name} crosses a system boundary and states ` +
        'no Version. When it changes, how will clients know which description they implement?'));
  }

  /** The names of an operation's input fields: inline, or the fields of the local type it names. */
  function inputFieldNames(declared, operation) {
    const { input } = operation;
    if (input === null) return [];
    if (input.fields) return input.fields.map((field) => field.name);
    const type = !input.type.invalid && !input.type.list && declared.types.get(input.type.name);
    return type ? type.fields.map((field) => field.name) : [];
  }

  function unboundParameter({ model }) {
    return fullFormInterfaces(model).flatMap((declared) => declared.operations.flatMap((operation) => {
      const names = inputFieldNames(declared, operation);
      return operation.placeholders.filter((name) => !names.includes(name)).map((name) => onInterface(declared, syntaxSpots(operation),
        `The syntax of ${operation.id} has the placeholder {${name}}, but its input has no field ${name}. A client cannot tell ` +
        'what to put there.', { operation: operation.id, hint: `Add an input field ${name} with its type and meaning.` }));
    }));
  }

  // ---- Semantic rules ------------------------------------------------------------------------

  const SEMANTIC_RULES = [
    rule('view/empty', 'warning', 'View shows no elements', 'A view with nothing in it answers no question.', BROWN, emptyView),
    rule('view/no-purpose', 'info', 'Custom view without a description', 'A custom view exists to answer one question; saying which keeps the view focused.', BROWN, viewWithoutPurpose),
    rule('c4/no-description', 'warning', 'Box without description or responsibilities', 'Every box in a C4 diagram carries a short description of what it is, so the box is never an unexplained name.', BROWN, noDescription),
    rule('c4/sparse-description', 'info', 'Description shorter than four words', 'A label such as "Web" repeats the name; a sentence says what the element is for.', BROWN, sparseDescription),
    rule('c4/no-technology', 'warning', 'Container or component without technology', 'C4 container and component boxes name their technology so readers see the technical choices.', BROWN, noTechnology),
    rule('c4/technology-tbd', 'info', 'Technology still to be decided', 'A placeholder is honest in a sketch but is a gap in a finished design.', BROWN, technologyTbd),
    rule('c4/vague-relationship', 'warning', 'Relationship description too vague', 'An arrow labeled "uses" says nothing a reader could not guess; the label names what is requested or exchanged.', BROWN, vagueRelationship),
    rule('c4/duplicate-relationship', 'warning', 'Relationship described twice', 'Two identical arrows between the same boxes add clutter, not information.', BROWN, duplicateRelationship),
    rule('c4/cross-container-technology', 'warning', 'Container-crossing relationship without technology', 'An arrow that crosses a container or system boundary is a network or process call; its protocol is what makes the diagram useful to implement.', BROWN, crossContainerTechnology),
    rule('c4/infrastructure-container', 'warning', 'Container technology names infrastructure', 'A container is a separately runnable application or data store; Docker, Kubernetes, and VMs are deployment, not a container.', BROWN, infrastructureContainer),
    rule('c4/external-decomposed', 'warning', 'External system with containers', 'A system your team does not build is a black box; its inside is not part of your design.', BROWN, externalDecomposed),
    rule('c4/duplicate-name', 'warning', 'Siblings with the same name', 'Two boxes with one name cannot be told apart in a diagram.', BROWN, duplicateName),
    rule('c4/isolated-element', 'warning', 'Element without any relationship', 'A box with no arrows is either unfinished or not part of the system.', BROWN, isolatedElement),
    rule('c4/generic-name', 'info', 'Generic name', 'Names such as "Backend" or "Service A" describe the kind of thing, not its job in the domain.', BROWN, genericName),
    rule('c4/large-view', 'warning', 'View with more than 20 elements', 'A diagram with too many boxes stops being readable; the threshold is a configurable heuristic (original design synthesis).', BROWN, largeView),
    rule('c4/broker-hub', 'info', 'Message broker drawn as one box', 'A broker as a single box hides which channel carries which message; queues and topics are the elements that matter.', BROWN, brokerHub),
    rule('rdd/no-responsibility', 'warning', 'Element without responsibilities', 'In Responsibility-Driven Design every design element exists to fulfill obligations; an element without any has no reason to exist yet (info for code elements and external systems).', RDD, noResponsibility),
    rule('rdd/untyped', 'warning', 'Responsibility without KNOW, DO, or DECIDE', 'Saying whether an element knows, does, or decides makes its role in the collaboration explicit.', RDD, untyped),
    rule('rdd/not-an-obligation', 'warning', 'Responsibility that reads as code or a UI step', 'A responsibility is an obligation stated in domain terms; a method call, field, getter, click, or HTTP request is an implementation detail.', RDD, notAnObligation),
    rule('rdd/vague', 'info', 'Vague responsibility', '"Handle", "manage", "process", and "support" with a single noun do not say what is known, done, or decided.', RDD, vagueResponsibility),
    rule('rdd/owner-named', 'info', 'Responsibility names another element as its subject', 'A responsibility belongs to the element that fulfills it; naming another element as the subject suggests it is assigned to the wrong place.', RDD, ownerNamed),
    rule('rdd/no-reason', 'warning', 'Collaborator without a description', 'A collaboration exists because one element needs help from another; the description says which help.', RDD, noReason),
    rule('rdd/duplicate-authority', 'warning', 'Fact owned in two places', 'An owned fact has a single source of truth and a single writer; a second owner off the same containment chain invites inconsistency (info when another element only KNOWs it; data stores the owner writes to keep it in custody).', RDD, duplicateAuthority),
    rule('rdd/duplicate-decision', 'info', 'Similar decision made in two places', 'Two elements that make the same decision can disagree; the keyword-overlap threshold is a heuristic (original design synthesis).', RDD, duplicateDecision),
    rule('rdd/god-element', 'warning', 'Element with too many responsibilities or collaborators', 'An element that knows and does too much is hard to understand and change; the limits of 9 unrefined responsibilities and 7 collaborators are configurable heuristics (original design synthesis); info for containers, never for systems.', RDD, godElement),
    rule('rdd/manager-name', 'info', 'Name ending in Manager, Processor, Handler, Helper, or Util', 'Such names describe a kind of work instead of a role and tend to collect unrelated responsibilities.', RDD, managerName),
    rule('rdd/centralized-control', 'info', 'One sibling makes every decision', 'A centralized style is simple to follow, but the central element grows with every new rule; a delegated style keeps each decision beside its data but asks maintainers to follow more collaborations. Which pays off depends on who maintains it and which changes come.', RDD, centralizedControl),
    rule('rdd/coordinator-decides', 'info', 'Coordinator that makes a decision', 'A coordinator sequences work and delegates decisions; a domain decision there may belong to a service provider or controller.', RDD, coordinatorDecides),
    rule('rdd/stereotype-mismatch', 'info', 'Role stereotype that does not fit the responsibilities', 'A controller decides, an information holder knows, and an interfacer connects to something outside its boundary.', RDD, stereotypeMismatch),
    rule('rdd/boundary-without-interfacer', 'info', 'External call without an interfacer', 'A component that talks to an external system translates between two vocabularies; marking it as an interfacer makes that role visible.', RDD, boundaryWithoutInterfacer),
    rule('rdd/unrefined', 'info', 'Responsibility no part refines', 'When an element is decomposed, each of its responsibilities is realized by some of its parts; an unrefined one is either missing a part or not really its obligation.', RDD, unrefined),
    rule('rdd/collaboration-cycle', 'info', 'Collaboration cycle among siblings', 'Siblings that depend on each other in a cycle cannot be understood, tested, or changed in isolation.', RDD, collaborationCycle),
    rule('rdd/unmeasurable-quality', 'info', 'Quality statement that cannot be measured', 'A quality requirement can be tested only when it states a number with its unit or a comparison.', RDD, unmeasurableQuality),
    rule('rdd/uncovered-requirement', 'info', 'Requirement no responsibility traces to', 'Tracing each requirement to a responsibility shows which element is accountable for it; whether the design actually meets the requirement is for review and testing to show.', RDD, uncoveredRequirement),
    rule('choices/unknown-pattern', 'info', 'Pattern not in the catalog', 'Catalog patterns get their roles checked and documentation links; other names are allowed.', PATTERN_SOURCE, unknownPattern),
    rule('choices/unknown-style', 'info', 'Architectural style not in the catalog', 'Catalog styles get documentation links; other names are allowed.', PATTERN_SOURCE, unknownStyle),
    rule('choices/unknown-role', 'warning', 'Role the pattern does not define', 'A pattern defines a fixed set of roles; an unknown role is usually a typo or a different pattern.', PATTERN_SOURCE, unknownRole),
    rule('choices/incomplete-pattern', 'warning', 'Pattern instance missing a required role', 'A pattern application needs an element in each required role, or the pattern is not really applied.', PATTERN_SOURCE, incompletePattern),
    rule('xlevel/scenario-step', 'error', 'Scenario step without a backing relationship', 'A dynamic view shows collaborations the static model declares; a step along no relationship, or a reply without a request, contradicts it.', BROWN, scenarioStep),
    rule('xlevel/scenario-levels', 'warning', 'Scenario mixes abstraction levels', 'A scenario that shows an element and its ancestor tells the same interaction at two levels.', BROWN, scenarioLevels),
    rule('xlevel/unreceived', 'info', 'Relationship received by no part', 'A relationship to a decomposed element should arrive at the part that handles it.', BROWN, unreceived),
    rule('xlevel/unsent', 'info', 'Relationship sent by no part', 'A relationship from a decomposed element should leave from the part that needs the help.', BROWN, unsent),
    rule('xlevel/unsummarized', 'info', 'Several relationships drawn as one without a summary', 'A derived edge shows only the first description; a declared summary says what the collaboration is at that level.', BROWN, unsummarized),
    rule('xlevel/summary-copy', 'info', 'Summary copied from its only detail', 'A summary that repeats its single lower-level relationship adds nothing the view would not derive.', BROWN, summaryCopy),
    rule('xlevel/undeployed', 'info', 'Container missing from a deployment', 'An environment that runs some containers of a system usually runs all of them; a missing one may be forgotten.', BROWN, undeployed),
    rule('checks/unexplained-ignore', 'warning', 'Ignore entry without a reason', 'Suppressing a rule without saying why leaves the next reader unable to judge whether it still applies.', SCHEMA_SOURCE),
    rule('checks/stale-ignore', 'info', 'Ignore entry that suppresses nothing', 'An ignore entry that no longer matches a diagnostic is dead weight and may hide a future problem.', SCHEMA_SOURCE),
  ];

  const CLEMENTS = 'Clements2010';
  /** An interface rule (category `interface`) also lists its learner message and hint patterns (spec §7.2). */
  function interfaceRule(id, severity, title, { message, hint = null, rationale, source }, check) {
    return Object.assign(rule(id, severity, title, rationale, source, check), { message, hint });
  }

  const SYNTACTIC_VIEW = { rationale: 'The syntactic view must say how to call the operation and what each parameter\'s type is; a type that is named but not described leaves the client guessing.', source: `${CLEMENTS}; lecture L14` };
  const FORMALIZE_SELECTIVELY = { rationale: 'Formalize contracts selectively: boundary-crossing, independently implemented collaborations need semantics; internal sketches may stay short.', source: 'WirfsBrock2003' };
  const EXPOSE_ONLY_NEEDED = { rationale: 'Expose only what is needed: names of tables, keys, and locks couple clients to the implementation, and operations no client uses must still be kept stable. Word lists produce false positives (a restaurant API has tables), and an unused operation may serve clients outside the model, hence info; `cursor` and `thread` are left out because pagination cursors and discussion threads are ordinary API vocabulary.', source: `Parnas1972; ${CLEMENTS}` };
  const UNITS_AND_FORMATS = { rationale: 'Syntactic interoperability is not enough: independently built systems read a number without a unit or a date without a format differently. The Mars Climate Orbiter\'s interface specification did state newton-seconds; one side wrote pound-force seconds and no test compared the file with the specification. A stated unit is what makes such a check possible. The exemptions keep false positives low: identifiers state a format, enumerated codes give each value a meaning. The string-name variants are info because names are weak evidence.', source: 'MCOMIB1999; Bass2012' };
  const CROSS_SYSTEM_USE = { rationale: 'Cross-system dependencies are where interoperability matters; an unused interface may be an entry point or dead weight, so the entry-point case is exempt and the rest is a question, not a verdict.', source: 'Bass2012' };
  const VERSIONS_AND_PLACEHOLDERS = { rationale: 'A shared interface changes in every system that uses it, so clients across a system boundary need to know which version they implement; a placeholder without a field cannot be called from the description alone.', source: `Bass2012; ${CLEMENTS}` };
  const withText = (shared, message, hint = null) => Object.assign({ message, hint }, shared);

  /** The interface rules (spec §7.2); they run only on a model that opts in to interface descriptions. */
  const INTERFACE_RULES = [
    interfaceRule('interface/no-syntax', 'warning', 'Operation without a syntax line', withText(SYNTACTIC_VIEW,
      '<op> has no syntax line. A client cannot call an operation it cannot write down.',
      'Write the call as a client would, such as GET /books/{isbn} or reserve(book) -> Loan.'), noSyntax),
    interfaceRule('interface/untyped-field', 'warning', 'Field without a type', withText(SYNTACTIC_VIEW,
      '<field> has no Type. Without one, a client cannot tell a number from text.',
      'Choose a primitive (string, integer, number, boolean, datetime, …) or a type of this interface.'), untypedField),
    interfaceRule('interface/undefined-type', 'warning', 'Type used but not described', withText(SYNTACTIC_VIEW,
      '<Name> is used as a type but not described. A client needs its fields to build or read it.',
      'Add <Name> under Types, or use a primitive such as string.'), undefinedType),
    interfaceRule('interface/no-purpose', 'warning', 'Operation without a purpose', {
      message: '<op> has no Purpose. A client cannot tell whether the operation fits its need.',
      hint: 'Say when a client calls it and what the provider then does.',
      rationale: 'Without a purpose a client cannot tell whether the operation fits its need; the purpose is the advertised responsibility.',
      source: `${CLEMENTS}; WirfsBrock2003` }, noPurpose),
    interfaceRule('interface/no-errors', 'warning', 'Operation without errors', {
      message: '<op> lists no errors. A client built by another team must know what can go wrong and what to do then.',
      hint: 'What happens when the caller is not allowed, sends something invalid, or calls too often?',
      rationale: 'Remote request/response and command calls always fail somehow (authentication, validation, rate limits, outages), and error handling is part of the semantic view, so a missing error list is a warning for them. An emitted event\'s risks are delivery guarantees (duplicates, order, loss), which the review prompt and the event frame ask about; in-process and unknown styles may genuinely not fail. Hence info there.',
      source: `${CLEMENTS}; Bass2012` }, noErrors),
    interfaceRule('interface/no-unit', 'warning', 'Number without a unit', withText(UNITS_AND_FORMATS,
      '<field> is a number with no Unit. Two teams can read the same number differently.',
      'Set Unit to what a value of 1 means (seconds, cents, kilograms, items).'), noUnit),
    interfaceRule('interface/no-format', 'warning', 'Date or time without a format', withText(UNITS_AND_FORMATS,
      '<field> is a date or time with no Format. Which comes first, day or month, and in which time zone?',
      'State the order of the parts and the time zone, for example YYYY-MM-DD in local time of the venue.'), noFormat),
    interfaceRule('interface/example-mismatch', 'warning', 'Example that contradicts its types', {
      message: 'Example <n> of <op> does not match its types: <problem>. An example that contradicts the syntax misleads every client that copies it.',
      rationale: 'The model-level counterpart of validating a document against its schema (lecture L14): a description must not contradict itself. Example values are illustrative, so warning rather than error.',
      source: 'lecture L14' }, exampleMismatch),
    interfaceRule('interface/realizes-internal', 'warning', 'Operation linked to a private obligation', {
      message: '<op> is linked to \'<text>\', an obligation private to <owner>. Clients rely on what <provider> promises, not on how its parts divide the work.',
      hint: 'Link the operation to the responsibility of <provider> that this one helps realize, or remove the link.',
      rationale: 'An RDD contract advertises the provider\'s obligations; its private implementation is not part of it.',
      source: 'WirfsBrock2003; Parnas1972' }, realizesInternal),
    interfaceRule('interface/in-process-across-boundary', 'warning', 'In-process interface used from another container', {
      message: '<interface> is an in-process interface of <provider>, and <source> runs in another container. A component is not separately deployable: a client elsewhere reaches it through an interface offered over the network.',
      hint: 'Use the interface of the container the request enters, or set the remote style the component exposes.',
      rationale: 'A C4 component is not separately deployable; a client in another container reaches it only through a remote interface. Linking it to a library call mixes abstraction levels.',
      source: 'Brown (c4model.com)' }, inProcessAcrossBoundary),
    interfaceRule('interface/requested-not-advertised', 'warning', 'Requested responsibility not advertised by the used operation', {
      message: 'This relationship asks <target> for \'<text>\', but the operation it uses is linked to other responsibilities. Does the client call the right operation, or is the operation\'s link incomplete?',
      rationale: 'In RDD the receiver advertises the responsibility a collaborator requests; a used operation that realizes something else contradicts the stated request.',
      source: 'WirfsBrock2003' }, requestedNotAdvertised),
    interfaceRule('interface/type-spelling', 'info', 'Type written in another language\'s spelling', {
      message: '<spelling> is written <standard> in interface descriptions; both mean the same, and the editor writes the standard form.',
      rationale: 'Standard type names make descriptions comparable across teams and languages; the other spelling is understood, so this is a suggestion.',
      source: '—' }, typeSpelling),
    interfaceRule('interface/syntax-only', 'info', 'Shorthand interface used across a boundary', withText(FORMALIZE_SELECTIVELY,
      '<interface> lists only call syntax, and <source> uses it across a <container or system> boundary. An independently built client also needs the purpose, the errors, and what the data means.',
      'Describe it fully.'), syntaxOnly),
    interfaceRule('interface/no-meaning', 'info', 'Field without a meaning', withText(FORMALIZE_SELECTIVELY,
      '<field> has no Meaning. A team that never spoke to you will guess.',
      'What does this field identify or measure, and for whom?'), noMeaning),
    interfaceRule('interface/no-example', 'info', 'Operation without an example', withText(FORMALIZE_SELECTIVELY,
      '<op> has no example. One request with its response shows a client more than a page of rules.'), noExample),
    interfaceRule('interface/unrealized', 'info', 'Operation not linked to a responsibility', {
      message: '<op> is not linked to a responsibility of <provider>. Which obligation does a client reach through it?',
      rationale: 'Connects an operation to the responsibility it serves; absent links are common in early sketches.',
      source: 'WirfsBrock2003' }, unrealized),
    interfaceRule('interface/leaks-implementation', 'info', 'Name that reveals implementation', withText(EXPOSE_ONLY_NEEDED,
      'Does \'<name>\' tell clients how <provider> stores or computes data? Names of tables, keys, and locks tie clients to the implementation.'),
    leaksImplementation),
    interfaceRule('interface/conflicting-vocabulary', 'info', 'Term with two meanings', {
      message: '\'<term>\' means different things in <A> and <B>. Two systems that read one word differently do not interoperate.',
      hint: 'Agree on one meaning in the shared vocabulary, or use two terms.',
      rationale: 'A shared vocabulary is a precondition of semantic interoperability; two meanings for one term signal a mismatch, unless the interfaces deliberately differ.',
      source: 'Bass2012; lecture L14' }, conflictingVocabulary),
    interfaceRule('interface/style-mismatch', 'info', 'Connector and interface style disagree on synchrony', {
      message: 'The relationship is drawn as <connector> but uses <interface>, a <style> interface. Is the call synchronous or not?',
      rationale: 'A message interface used through a synchronous call (or the reverse) contradicts the drawn connector; asynchronous REST patterns exist, hence info.',
      source: 'Clements2010' }, styleMismatch),
    interfaceRule('interface/unspecified-use', 'info', 'Cross-system dependency without an interface', withText(CROSS_SYSTEM_USE,
      '<source> depends on <target>, another software system, but names no interface. Which interface does it use?',
      '<target> offers <names>.'), unspecifiedUse),
    interfaceRule('interface/unused', 'info', 'Interface nobody uses', withText(CROSS_SYSTEM_USE,
      'No relationship uses <interface>. Is it an entry point for clients outside this model, or can it go?'), unused),
    interfaceRule('interface/unused-operation', 'info', 'Operation no client uses', withText(EXPOSE_ONLY_NEEDED,
      'No client uses <op>. Does any client need it? An interface that offers only what clients use is easier to keep stable.'), unusedOperation),
    interfaceRule('interface/no-version', 'info', 'Cross-system interface without a version', withText(VERSIONS_AND_PLACEHOLDERS,
      '<interface> crosses a system boundary and states no Version. When it changes, how will clients know which description they implement?'),
    noVersion),
    interfaceRule('interface/unbound-parameter', 'info', 'Placeholder without an input field', withText(VERSIONS_AND_PLACEHOLDERS,
      'The syntax of <op> has the placeholder {<name>}, but its input has no field <name>. A client cannot tell what to put there.',
      'Add an input field <name> with its type and meaning.'), unboundParameter),
  ];

  const RULES = STRUCTURAL_RULES.concat(SEMANTIC_RULES, INTERFACE_RULES);

  // ---- Runner --------------------------------------------------------------------------------

  function rangeAt(parsed, { path, part }) {
    const span = parsed && yamlAdapter.rangeOf(parsed, path, part);
    return span ? { start: span.start, end: span.end } : null;
  }

  /** The diagnostic of a finding: the range comes from the first spot that resolves in the parsed document. */
  function diagnosticOf(ruleDefinition, found, parsed) {
    const resolved = found.spots.find((candidate) => rangeAt(parsed, candidate));
    const where = resolved || found.spots[0] || null;
    return Object.assign({
      rule: ruleDefinition.id,
      severity: found.severity || ruleDefinition.severity,
      category: ruleDefinition.category,
      message: found.message,
      hint: found.hint,
      element: found.element,
      path: where ? where.path : null,
      range: resolved ? rangeAt(parsed, resolved) : null,
      fix: null,
    }, found.subject);
  }

  function thresholdsOf(options) {
    return Object.assign({}, DEFAULT_THRESHOLDS, options.thresholds);
  }

  /** Every view the model offers, projected once and only when a rule asks. */
  function projectedViewsOf(model) {
    let cached = null;
    return () => {
      if (!cached) cached = projection.listViews(model).map((view) => ({ view, projected: projection.projectView(model, view.selector) }));
      return cached;
    };
  }

  /**
   * Runs every rule that has a check on a model: the semantic rules and the saved-view selector rules.
   * `options.parsed` (the c4-yaml `parse` result) gives diagnostics their ranges, and `options.thresholds` overrides
   * the heuristic limits (`viewElements`, `unrefinedResponsibilities`, `collaborators`). Suppression and severity
   * configuration are `applyConfig`'s job.
   */
  function run(model, options = {}) {
    const context = { model, thresholds: thresholdsOf(options), projectedViews: projectedViewsOf(model) };
    const rules = STRUCTURAL_RULES.concat(SEMANTIC_RULES, interfacesActive(model) ? INTERFACE_RULES : []);
    return rules.filter((definition) => definition.check)
      .flatMap((definition) => definition.check(context).map((found) => diagnosticOf(definition, found, options.parsed)));
  }

  // ---- Configuration -------------------------------------------------------------------------

  function checkedSeverities(severity = {}) {
    Object.entries(severity).forEach(([ruleId, level]) => {
      if (!SEVERITIES.includes(level)) {
        throw new RangeError(`Unknown severity "${level}" for ${ruleId}; use ${SEVERITIES.join(', ')}`);
      }
    });
    return severity;
  }

  /** An ignore entry suppresses diagnostics of its rule, on its element when it names one (spec §4.8). */
  function suppresses(entry, diagnostic) {
    return entry.rule === diagnostic.rule && (entry.element === null || entry.element === diagnostic.element);
  }

  function ignoreFinding(entry, message, hint) {
    return finding(null, [spot(entry.path, 'value')], message, { hint });
  }

  function ignoreTarget(entry) {
    return `${entry.rule || 'a rule'}${entry.element ? ` on ${entry.element}` : ''}`;
  }

  /**
   * Applies the file's `checks.ignore` entries: entries without a reason are inactive and reported, active
   * entries drop the diagnostics they match, and active entries that matched nothing are reported as stale.
   */
  function applyFileIgnores(diagnostics, model, parsed) {
    const unexplained = model.ignores.filter((entry) => isBlank(entry.because));
    const active = model.ignores.filter((entry) => !isBlank(entry.because));
    const used = new Set();
    const kept = diagnostics.filter((diagnostic) => {
      if (diagnostic.category === 'checks') return true;
      const matching = active.filter((entry) => suppresses(entry, diagnostic));
      matching.forEach((entry) => used.add(entry));
      return matching.length === 0;
    });
    const definitions = new Map(SEMANTIC_RULES.map((definition) => [definition.id, definition]));
    const report = (ruleId, entry, message, hint) =>
      diagnosticOf(definitions.get(ruleId), ignoreFinding(entry, message, hint), parsed);
    return kept.concat(
      unexplained.map((entry) => report('checks/unexplained-ignore', entry,
        `The ignore entry for ${ignoreTarget(entry)} has no reason, so it is not applied`,
        'Add a because that says why the rule does not apply here.')),
      active.filter((entry) => !used.has(entry)).map((entry) => report('checks/stale-ignore', entry,
        `The ignore entry for ${ignoreTarget(entry)} suppresses nothing`,
        'Remove it, or fix its rule or element.')));
  }

  /**
   * Applies the configuration to diagnostics (spec §7.2): `honorFileIgnores` (default true), `disable` (rule ids),
   * `severity` (rule id to level), `hideInfo`, and `suppressIncompleteFor` (element and interface ids whose incompleteness
   * rules stay silent; element ids match exactly, interface ids ignoring case). `parsed` in the options gives the
   * ignore diagnostics their ranges. Returns new diagnostics.
   */
  function applyConfig(diagnostics, model, options = {}) {
    const { honorFileIgnores = true, disable = [], hideInfo = false, suppressIncompleteFor = [] } = options;
    const levels = checkedSeverities(options.severity);
    const disabled = new Set(disable);
    const heldElements = new Set(suppressIncompleteFor);
    const heldInterfaces = new Set(suppressIncompleteFor.map((id) => id.toLowerCase()));
    const heldBack = (diagnostic) => heldElements.has(diagnostic.element)
      || (Boolean(diagnostic.interface) && heldInterfaces.has(diagnostic.interface.toLowerCase()));
    const afterIgnores = honorFileIgnores ? applyFileIgnores(diagnostics, model, options.parsed) : diagnostics;
    return afterIgnores
      .filter((diagnostic) => !disabled.has(diagnostic.rule))
      .map((diagnostic) => (levels[diagnostic.rule] ? Object.assign({}, diagnostic, { severity: levels[diagnostic.rule] }) : diagnostic))
      .filter((diagnostic) => !(hideInfo && diagnostic.severity === 'info'))
      .filter((diagnostic) => !(INCOMPLETENESS_RULES.has(diagnostic.rule) && heldBack(diagnostic)));
  }

  return { RULES, DEFAULT_THRESHOLDS, run, applyConfig, isInProcessAcrossBoundary };
});
