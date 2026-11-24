(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-schema.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.projection = factory(parts.schema);
  }
})(typeof self !== 'undefined' ? self : this, function (schema) {
  'use strict';

  // The view catalog (spec §5.1): selector parsing, resolution against a model, breadcrumbs, and drill targets.

  const ELEMENT_SCOPED = schema.ELEMENT_SCOPE_TYPES;
  const CRUMB_LABELS = { context: 'Context', containers: 'Containers', components: 'Components', code: 'Code', dynamic: 'Dynamic', deployment: 'Deployment' };
  const TITLE_PREFIXES = {
    context: 'System context view', containers: 'Container view', components: 'Component view',
    code: 'Code view', dynamic: 'Dynamic view', deployment: 'Deployment view',
  };
  const DRILL_VIEW = { system: 'containers', container: 'components', component: 'code' };

  const { parseSelector, canonicalSelector } = schema;
  /** The element types an `interfaces of` view is drawn for (spec §5.1). */
  const INTERFACE_SCOPE_TYPES = ['system', 'container', 'component'];
  /** `interface of <x>`: a likely typo of `interfaces of <x>` (spec §5.1). */
  const SINGULAR_INTERFACES_OF = /^\s*interface\s+of\s+(\S+)\s*$/i;

  function viewDiagnostic(rule, message, hint) {
    return { diagnostic: { rule, severity: 'error', category: 'view', message, hint, element: null, path: null, range: null, fix: null } };
  }

  /** The interface with `id`, compared ignoring case (spec §4.11); null when there is none. */
  function interfaceById(model, id) {
    const lower = id.toLowerCase();
    return [...model.interfaces.values()].find((declared) => declared.id.toLowerCase() === lower) || null;
  }

  /**
   * Resolves selector text against a model to `{ request }`, or `{ diagnostic }` naming the problem: an unknown or
   * malformed selector, a scope of the wrong type, or an annotation the base view does not take (spec §5.1).
   */
  function resolveView(model, text) {
    const selector = parseSelector(text);
    if (selector.error) return malformedSelector(text, selector.error);
    return scopeProblem(model, selector) || misplacedAnnotation(model, selector) || { request: selector };
  }

  function malformedSelector(text, error) {
    const singular = SINGULAR_INTERFACES_OF.exec(String(text));
    if (!singular) return viewDiagnostic('view/unknown-selector', error, null);
    const suggestion = `interfaces of ${singular[1]}`;
    return viewDiagnostic('view/unknown-selector', `There is no interface named of; did you mean ${suggestion}?`,
      `Write ${suggestion} for the interfaces an element provides and uses`);
  }

  /** The diagnostic for a scope that does not exist or has the wrong type; null when the scope fits the view. */
  function scopeProblem(model, selector) {
    const { type, scopeId, viewId } = selector;
    const unknown = (what, map) => viewDiagnostic('view/unknown-selector', `There is no ${what} named ${scopeId || viewId}`,
      unknownHint(map, scopeId || viewId));
    if (type === 'landscape') return null;
    if (type === 'interface') return interfaceProblem(model, selector);
    if (type === 'custom') return model.views.has(viewId) ? null : unknown('view', model.views);
    if (type === 'dynamic' || type === 'deployment') {
      const named = type === 'dynamic' ? model.scenarios : model.environments;
      return named.has(scopeId) ? null : unknown(type === 'dynamic' ? 'scenario' : 'environment', named);
    }
    const element = model.elements.get(scopeId);
    if (!element) return unknown('element', model.elements);
    if (type === 'interfaces') return interfacesScopeProblem(element);
    if (element.type !== ELEMENT_SCOPED[type]) {
      return viewDiagnostic('view/wrong-scope-type', `${CRUMB_LABELS[type]} views are drawn for a ${ELEMENT_SCOPED[type]}, but ${element.id} is a ${element.type}`,
        `Name a ${ELEMENT_SCOPED[type]} after ${type} of`);
    }
    return null;
  }

  function interfacesScopeProblem(element) {
    if (INTERFACE_SCOPE_TYPES.includes(element.type)) return null;
    const message = `Interface views are drawn for a system, container, or component, but ${element.id} is a ${element.type}`;
    const hint = element.type === 'code'
      ? `The operations of ${element.id} appear in the code view of its component: code of ${element.parentId}`
      : 'Name a system, container, or component after interfaces of';
    return viewDiagnostic('view/wrong-scope-type', message, hint);
  }

  /** `interface <id>` must name an interface, and a trailing `of <element>` its provider (spec §5.1). */
  function interfaceProblem(model, { interfaceId, ofId }) {
    const declared = interfaceById(model, interfaceId);
    if (!declared) {
      const suggestion = schema.suggest(interfaceId, [...model.interfaces.keys()]);
      return viewDiagnostic('view/unknown-selector', `There is no interface named ${interfaceId}`,
        suggestion ? `Did you mean interface ${suggestion.toLowerCase()}?` : 'Choose one of the listed views');
    }
    if (ofId === null || ofId === declared.providerId) return null;
    const provider = model.elements.get(declared.providerId);
    return viewDiagnostic('view/wrong-scope-type', `${declared.name} is an interface of ${provider.name}, not of ${ofId}`,
      `Write interface ${declared.id.toLowerCase()} of ${provider.id}, or leave out "of ${ofId}"`);
  }

  /** The diagnostic for a `with …` annotation that the (custom view's) base view does not take (spec §5.1). */
  function misplacedAnnotation(model, selector) {
    const baseType = selector.type === 'custom' ? customBaseType(model.views.get(selector.viewId)) : selector.type;
    if (baseType === null) return null;
    const misplaced = selector.annotations.find((annotation) => !schema.ANNOTATION_BASES[annotation].includes(baseType));
    if (!misplaced) return null;
    return viewDiagnostic('view/wrong-scope-type', `The ${misplaced} annotation is not allowed on ${baseType} views; it is allowed on ` +
      `${schema.ANNOTATION_BASES[misplaced].join(', ')} views`, `Remove "with ${misplaced}"`);
  }

  /** The type of the built-in view a custom view is drawn over; null when it names none (reported on projection). */
  function customBaseType(custom) {
    const base = parseSelector(custom.view || '');
    return base.error || base.type === 'custom' ? null : base.type;
  }

  /** Points to an id that differs only in case (ids are case-sensitive, spec §4.10), else to the listed views. */
  function unknownHint(map, id) {
    const lowered = id.toLowerCase();
    const sameButCase = [...map.keys()].find((key) => key.toLowerCase() === lowered);
    return sameButCase ? `Ids are case-sensitive; did you mean ${sameButCase}?` : 'Choose one of the listed views';
  }

  function elementView(type, element) {
    return { selector: `${type} of ${element.id}`, type, scopeId: element.id, title: scopedTitle(type, element) };
  }

  /**
   * Every view the model offers: landscape, then each level in document order, scenarios, environments, custom views.
   * With `{ interfaces: true }`, then the interfaces view of every system, container, and component that provides or
   * requires an interface, and the description of every interface (`scopeId` is the interface id), in document order.
   */
  function listViews(model, { interfaces = false } = {}) {
    const elements = [...model.elements.values()];
    const ofType = (elementType) => elements.filter((element) => element.type === elementType);
    const withChildren = (elementType) => ofType(elementType).filter((element) => element.childIds.length > 0);
    const views = [{ selector: 'landscape', type: 'landscape', scopeId: null, title: 'System landscape' }]
      .concat(
        ofType('system').filter((system) => !system.external).map((system) => elementView('context', system)),
        withChildren('system').map((system) => elementView('containers', system)),
        withChildren('container').map((container) => elementView('components', container)),
        withChildren('component').map((component) => elementView('code', component)),
        [...model.scenarios.values()].map((scenario) => ({
          selector: `dynamic ${scenario.id}`, type: 'dynamic', scopeId: scenario.id, title: `${TITLE_PREFIXES.dynamic}: ${scenario.title || scenario.id}` })),
        [...model.environments.values()].map((environment) => ({
          selector: `deployment ${environment.id}`, type: 'deployment', scopeId: environment.id, title: `${TITLE_PREFIXES.deployment}: ${environment.name || environment.id}` })),
        [...model.views.values()].map((view) => ({
          selector: view.id, type: 'custom', scopeId: null, title: view.title || view.id })));
    return interfaces ? views.concat(interfaceViews(model, elements)) : views;
  }

  function interfaceViews(model, elements) {
    const hasInterfaces = (element) => INTERFACE_SCOPE_TYPES.includes(element.type)
      && (providedInterfaces(model, element.id).length > 0 || requiredInterfaces(model, element.id).length > 0);
    return elements.filter(hasInterfaces).map((element) => ({
      selector: canonicalSelector({ type: 'interfaces', scopeId: element.id }), type: 'interfaces', scopeId: element.id,
      title: interfacesTitle(element),
    })).concat([...model.interfaces.values()].map((declared) => ({
      selector: canonicalSelector({ type: 'interface', interfaceId: declared.id }), type: 'interface', scopeId: declared.id,
      title: interfaceTitle(declared),
    })));
  }

  function interfacesTitle(element) {
    return `Interface view: ${element.name}`;
  }

  function interfaceTitle(declared) {
    return `Interface description: ${declared.name}`;
  }

  /** The selector an embed shows without `view:`: the context of the first internal system, else the landscape. */
  function defaultView(model) {
    for (const id of model.rootIds) {
      const element = model.elements.get(id);
      if (element.type === 'system' && !element.external) return `context of ${id}`;
    }
    return 'landscape';
  }

  function crumb(type, scopeId, label) {
    return { selector: canonicalSelector({ type, scopeId }), label: `${CRUMB_LABELS[type]}: ${label}` };
  }

  /** Ancestors of `element` from the system down to the element itself. */
  function lineage(model, element) {
    const chain = [];
    for (let current = element; current; current = current.parentId && model.elements.get(current.parentId)) chain.unshift(current);
    return chain;
  }

  /** The view that shows an element as a primary element (spec §5.1): its own context view, or its parent's level. */
  function viewShowing(element) {
    if (element.type === 'system') return { type: 'context', scopeId: element.id };
    return { type: element.type === 'container' ? 'containers' : 'components', scopeId: element.parentId };
  }

  /**
   * Breadcrumbs from the landscape down to the requested view (spec §5.2 step 8). An interface view is a view of its
   * element, not a level (J14): its crumb follows the trail of the view showing that element (spec §5.1).
   */
  function breadcrumbs(model, request) {
    const { type, scopeId } = request;
    if (type === 'interfaces') {
      const element = model.elements.get(scopeId);
      return breadcrumbs(model, viewShowing(element))
        .concat({ selector: canonicalSelector({ type, scopeId }), label: `Interfaces of ${element.name}` });
    }
    if (type === 'interface') {
      const declared = interfaceById(model, request.interfaceId);
      return breadcrumbs(model, viewShowing(model.elements.get(declared.providerId)))
        .concat({ selector: canonicalSelector({ type, interfaceId: declared.id }), label: interfaceTitle(declared) });
    }
    const trail = [{ selector: 'landscape', label: 'Landscape' }];
    if (ELEMENT_SCOPED[type]) {
      const scope = model.elements.get(scopeId);
      const chain = lineage(model, scope);
      // A view of level L shows the crumb of every level above it, each named for the ancestor it zooms into.
      const levels = ['context', 'containers', 'components', 'code'];
      const parentLevels = levels.slice(1, levels.indexOf(type) + 1);
      trail.push(crumb('context', chain[0].id, chain[0].name));
      parentLevels.forEach((level, index) => {
        const owner = level === type ? scope : chain[index];
        trail.push(crumb(level, owner.id, owner.name));
      });
    } else if (type === 'dynamic') {
      trail.push(crumb(type, scopeId, model.scenarios.get(scopeId).title || scopeId));
    } else if (type === 'deployment') {
      trail.push(crumb(type, scopeId, model.environments.get(scopeId).name || scopeId));
    } else if (type === 'custom') {
      trail.push({ selector: request.viewId, label: model.views.get(request.viewId).title || request.viewId });
    }
    return trail;
  }

  /** The selector one level down from an element, or null when it has nothing to zoom into. */
  function drillTarget(model, elementId) {
    const element = model.elements.get(elementId);
    if (!element || !DRILL_VIEW[element.type] || element.childIds.length === 0) return null;
    return `${DRILL_VIEW[element.type]} of ${element.id}`;
  }

  // ---- Interfaces of an element (spec §5.3 rules 1–3) -----------------------------------------

  /** Use kinds that make the source require the interface (an emission is not a requirement). */
  const REQUIRING_KINDS = ['request', 'broker-peer'];

  function providedEntry(model, declared, declaredOnId, delegatedFromId) {
    const nameOf = (id) => (id === null ? null : model.elements.get(id).name);
    return { interfaceId: declared.id, name: declared.name, declaredOnId, declaredOnName: nameOf(declaredOnId),
      delegatedFromId, delegatedFromName: nameOf(delegatedFromId) };
  }

  /** True when a relationship from outside `outsideId` uses the interface, targeting `targetWithinId` or its parts when given. */
  function usedFromOutside(model, interfaceId, outsideId, targetWithinId = null) {
    return model.relationships.some((relationship) => !isSameOrInside(model, relationship.sourceId, outsideId)
      && (targetWithinId === null || isSameOrInside(model, relationship.targetId, targetWithinId))
      && relationship.uses.some((use) => use.interfaceId === interfaceId));
  }

  /**
   * The interfaces an element provides (spec §5.3 rule 1), in this order: those declared on it; those declared on a
   * part of it that a relationship from outside it uses (`declaredOn`); and those declared on an ancestor that a
   * relationship from outside that ancestor uses while targeting the element or a part of it (`delegatedFrom`).
   */
  function providedInterfaces(model, elementId) {
    const declared = [...model.interfaces.values()];
    const own = declared.filter((entry) => entry.providerId === elementId)
      .map((entry) => providedEntry(model, entry, null, null));
    const offered = declared.filter((entry) => contains(model, elementId, entry.providerId)
      && usedFromOutside(model, entry.id, elementId))
      .map((entry) => providedEntry(model, entry, entry.providerId, null));
    const delegated = declared.filter((entry) => contains(model, entry.providerId, elementId)
      && usedFromOutside(model, entry.id, entry.providerId, elementId))
      .map((entry) => providedEntry(model, entry, null, entry.providerId));
    return own.concat(offered, delegated);
  }

  /**
   * The interfaces an element requires (spec §5.3 rule 2): each interface that a request or broker-peer use names on a
   * relationship from the element or a part of it to the outside, once, in relationship order.
   */
  function requiredInterfaces(model, elementId) {
    const required = new Map();
    model.relationships
      .filter((relationship) => isSameOrInside(model, relationship.sourceId, elementId)
        && !isSameOrInside(model, relationship.targetId, elementId))
      .flatMap((relationship) => relationship.uses.filter((use) => REQUIRING_KINDS.includes(use.kind)))
      .filter((use) => !required.has(use.interfaceId))
      .forEach((use) => {
        const declared = model.interfaces.get(use.interfaceId);
        required.set(use.interfaceId, { interfaceId: declared.id, name: declared.name, providerId: declared.providerId });
      });
    return [...required.values()];
  }

  /** The element that uses an interface through a relationship: the source of a request or broker-peer use, the subscriber of an emission. */
  function userOf(relationship, use) {
    if (REQUIRING_KINDS.includes(use.kind)) return relationship.sourceId;
    return use.kind === 'emit' ? relationship.targetId : null;
  }

  /** The queue or topic a broker-peer use passes through; null for any other use. */
  function throughIdOf(relationship, use) {
    return use.kind === 'broker-peer' ? relationship.targetId : null;
  }

  /**
   * Every use of an interface the element provides by a user outside it, in relationship order, as
   * `{ interfaceId, elementId, throughId, person, use }` with the user lifted to the element's level of abstraction.
   * A delegated interface counts only the uses that target the element or its parts.
   */
  function consumingUses(model, elementId) {
    const scope = model.elements.get(elementId);
    const provided = new Map(providedInterfaces(model, elementId).map((entry) => [entry.interfaceId, entry]));
    return model.relationships.flatMap((relationship) => relationship.uses.flatMap((use) => {
      const entry = provided.get(use.interfaceId);
      const userId = entry ? userOf(relationship, use) : null;
      if (userId === null || isSameOrInside(model, userId, elementId)) return [];
      if (entry.delegatedFromId && !isSameOrInside(model, relationship.targetId, elementId)) return [];
      const lifted = liftBeside(model, scope, userId);
      if (!lifted) return []; // an ancestor of the element: nothing stands beside the element for it
      return [{ interfaceId: use.interfaceId, elementId: lifted.id, throughId: throughIdOf(relationship, use),
        person: lifted.type === 'person', use }];
    }));
  }

  /** The key of one assembly: an interface between one pair of elements, through one channel or none. */
  function assemblyKey(interfaceId, providerId, consumerId, throughId) {
    return [interfaceId, providerId, consumerId, throughId].join('\u0000');
  }

  /**
   * The consumers of the interfaces an element provides (spec §5.3 rule 3), in relationship order and once each:
   * every user outside the element, lifted to the element's level of abstraction, with the queue or topic of a
   * broker-peer use as `throughId`. A delegated interface counts only the uses that target the element or its parts.
   */
  function interfaceConsumers(model, elementId) {
    const seen = new Set();
    return consumingUses(model, elementId)
      .filter(({ interfaceId, elementId: userId, throughId }) => {
        const key = assemblyKey(interfaceId, elementId, userId, throughId);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ interfaceId, elementId: userId, throughId, person }) => ({ interfaceId, elementId: userId, throughId, person }));
  }

  // ---- C4-notation projection (spec §5.2) -----------------------------------------------------

  const TECHNOLOGY_FREE_VIEWS = ['landscape', 'context'];
  const ENTERPRISE_VIEWS = ['landscape', 'context'];
  const LARGE_VIEW_THRESHOLD = 20;
  const ENTERPRISE_BOUNDARY_ID = 'boundary:enterprise';
  const GROUP_BOUNDARY_PREFIX = 'boundary:group:';
  const ELEMENT_TYPE_LABELS = { person: 'Person', system: 'Software System', container: 'Container', component: 'Component' };
  const BOX_RESPONSIBILITY_LINES = 3;
  const LEGEND = [
    ['person', 'Person'],
    ['system', 'Software system'],
    ['container', 'Container'],
    ['browser_app', 'Container: browser application'],
    ['mobile_app', 'Container: mobile application'],
    ['desktop_app', 'Container: desktop application'],
    ['function', 'Container: function'],
    ['database', 'Container: database'],
    ['file_store', 'Container: file store'],
    ['queue', 'Container: queue'],
    ['topic', 'Container: topic'],
    ['component', 'Component'],
    ['external', 'External: not designed or owned by this team'],
    ['boundary-scope', 'Boundary of the element shown in detail'],
    ['group', 'Group'],
    ['enterprise', 'Enterprise boundary'],
    ['async', 'Asynchronous relationship'],
    ['unassigned', 'Relationship not yet assigned to a container or component'],
  ];

  function scopedTitle(type, element) {
    return `${TITLE_PREFIXES[type]}: ${element.name}`;
  }

  /** True when `ancestorId` contains `id` at any depth. */
  function contains(model, ancestorId, id) {
    for (let current = model.elements.get(id); current && current.parentId; current = model.elements.get(current.parentId)) {
      if (current.parentId === ancestorId) return true;
    }
    return false;
  }

  const DEFAULT_DIRECTION = 'down';

  /** The direction a view is laid out in: its custom view's, else down (spec §6.4). */
  function directionOf(custom) {
    return custom ? custom.direction : DEFAULT_DIRECTION;
  }

  /** The ViewModel of a view that cannot be drawn (`type: null`): no content, only the diagnostics saying why. */
  function errorView(key, diagnostics) {
    return {
      key, selector: key, annotations: [], type: null, scopeId: null, notation: 'c4', title: null, description: null,
      nodes: [], boundaries: [], edges: [], legend: [], breadcrumbs: [], elementCount: 0, large: false, uml: null, card: null,
      direction: DEFAULT_DIRECTION, diagnostics,
    };
  }

  /** The built-in view a custom view is drawn over, as `{ request }` or `{ diagnostic }`. */
  function resolveBaseView(model, custom) {
    const resolved = resolveView(model, custom.view || '');
    if (resolved.diagnostic || resolved.request.type !== 'custom') return resolved;
    return viewDiagnostic('view/unknown-selector', `The custom view ${custom.id} is drawn over ${custom.view}, which is not a built-in view`,
      'Set view to a built-in selector such as containers of <system>');
  }

  /**
   * Projects a view selector to a ViewModel (spec §5.2). A selector that does not resolve yields an empty view
   * carrying the diagnostic.
   */
  function projectView(model, selectorText) {
    const resolved = resolveView(model, selectorText);
    if (resolved.diagnostic) return errorView(schema.selectorKey(selectorText), [resolved.diagnostic]);
    const { request } = resolved;
    const custom = request.type === 'custom' ? model.views.get(request.viewId) : null;
    const base = custom ? resolveBaseView(model, custom) : resolved;
    if (base.diagnostic) return errorView(request.base, [base.diagnostic]);
    if (INTERFACE_PROJECTIONS[base.request.type]) return projectInterfaceView(model, request, base.request, custom);
    if (UML_PROJECTIONS[base.request.type]) return projectUmlView(model, request, base.request, custom);
    return projectC4View(model, request, base.request, custom);
  }

  /** The annotations a view carries (spec §5.2 item 11): the selector's, its base view's, and a custom view's own, sorted. */
  function effectiveAnnotations(request, base, custom) {
    const all = request.annotations.concat(base.annotations, custom ? custom.annotations : []);
    return [...new Set(all)].sort();
  }

  /** The elements a view exists to show (spec §5.1). */
  function primaryIds(model, type, scope) {
    if (type === 'landscape') return model.rootIds;
    if (type === 'context') return [scope.id];
    return scope.childIds;
  }

  /**
   * Step 1: eligible elements, the elements drawn as boundaries, and the anchors whose direct neighbours are kept
   * (the primary elements and the scope boundary). Including an element turns each ancestor that would be a node
   * into a labelled boundary around it; a primary turned into a boundary stays an anchor, and so do the elements
   * included inside it.
   */
  function selectElements(model, { type, scopeId }, include) {
    const scope = scopeId ? model.elements.get(scopeId) : null;
    const system = scope && type === 'components' ? model.elements.get(scope.parentId) : scope;
    const roots = type === 'landscape' || type === 'context' ? model.rootIds : model.rootIds.filter((id) => id !== system.id);
    const primaries = primaryIds(model, type, scope);
    const eligible = new Set(roots.concat(type === 'components' ? system.childIds.filter((id) => id !== scopeId) : [], primaries));
    const scopeBoundaryId = type === 'containers' || type === 'components' ? scopeId : null;
    const boundaryIds = new Set(scopeBoundaryId ? [scopeBoundaryId] : []);
    const anchorIds = new Set(primaries.concat(boundaryIds.size ? [scopeBoundaryId] : []));
    include.forEach((id) => {
      eligible.add(id);
      for (let ancestor = model.elements.get(model.elements.get(id).parentId); ancestor; ancestor = model.elements.get(ancestor.parentId)) {
        if (!eligible.delete(ancestor.id)) continue;
        boundaryIds.add(ancestor.id);
        if (anchorIds.has(ancestor.id)) anchorIds.add(id);
      }
    });
    return { eligible, boundaryIds, anchorIds, scopeBoundaryId, included: include };
  }

  /** Step 2: the nearest eligible ancestor-or-self of an endpoint, or the boundary it lands on; null when neither. */
  function liftEndpoint(model, id, selection) {
    for (let element = model.elements.get(id); element; element = model.elements.get(element.parentId)) {
      if (selection.eligible.has(element.id)) return { id: element.id, boundary: false };
      if (selection.boundaryIds.has(element.id)) return { id: element.id, boundary: true };
    }
    return null;
  }

  /** Every relationship with both endpoints lifted; self-loops and edges into an endpoint's own boundary vanish. */
  function liftRelationships(model, selection) {
    const lifted = [];
    model.relationships.forEach((relationship) => {
      const source = liftEndpoint(model, relationship.sourceId, selection);
      const target = liftEndpoint(model, relationship.targetId, selection);
      if (!source || !target || source.id === target.id) return;
      if (contains(model, source.id, target.id) || contains(model, target.id, source.id)) return;
      lifted.push({
        relationship, sourceId: source.id, targetId: target.id, sourceIsBoundary: source.boundary, targetIsBoundary: target.boundary,
        derived: source.id !== relationship.sourceId || target.id !== relationship.targetId,
      });
    });
    return lifted;
  }

  /** Step 4: a boundary landing is covered when a child of that boundary has an edge with the same counterpart and direction. */
  function isCoveredLanding(model, edge, lifted) {
    const coveredAt = (boundaryEnd, counterpartEnd) => lifted.some((other) => other[counterpartEnd] === edge[counterpartEnd]
      && contains(model, edge[boundaryEnd], other[boundaryEnd]));
    return (edge.targetIsBoundary && coveredAt('targetId', 'sourceId')) || (edge.sourceIsBoundary && coveredAt('sourceId', 'targetId'));
  }

  /** Step 3: the elements drawn as nodes: anchors and included elements, plus the direct neighbours of anchors. */
  function keptElements(lifted, selection) {
    const { anchorIds, boundaryIds } = selection;
    const kept = new Set([...anchorIds, ...selection.included]);
    lifted.forEach((edge) => {
      if (anchorIds.has(edge.sourceId) && !edge.targetIsBoundary) kept.add(edge.targetId);
      if (anchorIds.has(edge.targetId) && !edge.sourceIsBoundary) kept.add(edge.sourceId);
    });
    boundaryIds.forEach((id) => kept.delete(id));
    return kept;
  }

  /** The declared relationship behind an edge, with the names of its own ends. */
  function sourceRelationship(model, relationship) {
    const nameOf = (id) => model.elements.get(id).name;
    return { id: relationship.id, sourceName: nameOf(relationship.sourceId), targetName: nameOf(relationship.targetId) };
  }

  /**
   * Lower-level relationships of the same synchrony that lift onto a declared relationship's pair: the relationships it
   * summarizes (spec §4.11, §5.2 item 9). Exported as the one definition the checks `xlevel/unsummarized` and
   * `xlevel/summary-copy` share with the inherited uses of an edge.
   */
  function summarizedBy(model, summary) {
    return model.relationships.filter((relationship) => relationship.async === summary.async
      && (relationship.sourceId !== summary.sourceId || relationship.targetId !== summary.targetId)
      && isSameOrInside(model, relationship.sourceId, summary.sourceId) && isSameOrInside(model, relationship.targetId, summary.targetId));
  }

  /** An edge's uses: a declared relationship's own, else those it summarizes (inherited); the merged sources' for a derived edge. */
  function edgeUses(model, members, derived) {
    if (derived) return members.flatMap((member) => member.relationship.uses);
    const { relationship } = members[0];
    if (relationship.uses.length > 0) return relationship.uses;
    return summarizedBy(model, relationship).flatMap((summarized) => summarized.uses)
      .map((use) => Object.assign({}, use, { inherited: true }));
  }

  /**
   * The interfaces of an edge (spec §5.2 item 9): one entry per interface in the order of `uses`, with its used
   * operations once each, or none when any use names the whole interface; inherited when every use of it is.
   */
  function edgeInterfaces(model, uses) {
    const byId = new Map();
    uses.forEach((use) => {
      if (!byId.has(use.interfaceId)) byId.set(use.interfaceId, { operationIds: [], whole: false, inherited: true });
      const entry = byId.get(use.interfaceId);
      if (use.operationId === null) entry.whole = true;
      else if (!entry.operationIds.includes(use.operationId)) entry.operationIds.push(use.operationId);
      entry.inherited = entry.inherited && use.inherited;
    });
    return [...byId].map(([interfaceId, { operationIds, whole, inherited }]) => ({
      interfaceId, name: model.interfaces.get(interfaceId).name, operationIds: whole ? [] : operationIds, inherited }));
  }

  /** The technology every interface of an edge agrees on; null when there is none, or they differ (spec §4.6). */
  function agreedInterfaceTechnology(model, interfaces) {
    const technologies = new Set(interfaces.map((entry) => model.interfaces.get(entry.interfaceId).technology));
    return interfaces.length > 0 && technologies.size === 1 ? [...technologies][0] : null;
  }

  /**
   * An edge's technology and where it comes from: the one its relationships share ('relationship'); when none of them
   * declares one, the one its interfaces agree on ('interface'); else none. Context and landscape views show none.
   */
  function edgeTechnology(model, members, interfaces, view) {
    const technologies = new Set(members.map((member) => member.relationship.technology));
    if (TECHNOLOGY_FREE_VIEWS.includes(view.type) || technologies.size !== 1) return { technology: null, technologySource: null };
    const [declared] = technologies;
    if (declared !== null) return { technology: declared, technologySource: 'relationship' };
    const agreed = agreedInterfaceTechnology(model, interfaces);
    return { technology: agreed, technologySource: agreed === null ? null : 'interface' };
  }

  function edgeOf(model, members, view) {
    const [first] = members;
    const { relationship } = first;
    const interfaces = edgeInterfaces(model, edgeUses(model, members, first.derived));
    const { technology, technologySource } = edgeTechnology(model, members, interfaces, view);
    return {
      id: first.derived ? `${first.sourceId}->${first.targetId}/${relationship.async ? 'async' : 'sync'}` : relationship.id,
      sourceId: first.sourceId,
      targetId: first.targetId,
      description: relationship.description,
      technology,
      technologySource,
      interfaces,
      connector: relationship.connector,
      async: relationship.async,
      derived: first.derived,
      sources: members.map((member) => member.relationship.id),
      sourceRelationships: members.map((member) => sourceRelationship(model, member.relationship)),
      moreCount: members.length - 1,
      unassigned: first.sourceId === view.scopeBoundaryId || first.targetId === view.scopeBoundaryId,
    };
  }

  /** Step 5: declared edges stand alone and suppress derived edges of the same synchrony; derived edges merge per pair. */
  function mergeEdges(model, drawnEdges, view) {
    const pairKey = (edge) => `${edge.sourceId}->${edge.targetId}/${edge.relationship.async}`;
    const declaredPairs = new Set(drawnEdges.filter((edge) => !edge.derived).map(pairKey));
    const groups = [];
    const groupByPair = new Map();
    drawnEdges.forEach((edge) => {
      if (!edge.derived) {
        groups.push([edge]);
        return;
      }
      const key = pairKey(edge);
      if (declaredPairs.has(key)) return;
      if (!groupByPair.has(key)) {
        groupByPair.set(key, []);
        groups.push(groupByPair.get(key));
      }
      groupByPair.get(key).push(edge);
    });
    return groups.map((members) => edgeOf(model, members, view));
  }

  function typeLabel(element) {
    const abstraction = ELEMENT_TYPE_LABELS[element.type];
    const parts = [element.technology ? `${abstraction}: ${element.technology}` : abstraction];
    if (element.external) parts.push('external');
    return parts.join(', ');
  }

  /** Box text (spec §6.1): the description, else the first responsibilities and how many more there are. */
  function boxLines(element) {
    if (element.description) return [element.description];
    const shown = element.responsibilities.slice(0, BOX_RESPONSIBILITY_LINES)
      .map((responsibility) => (responsibility.kind ? `${responsibility.kind.toUpperCase()} ${responsibility.text}` : responsibility.text));
    const hidden = element.responsibilities.length - shown.length;
    return hidden > 0 ? shown.concat(`+${hidden} more`) : shown;
  }

  /** Annotations drawn from an element's design choices; `interfaces` is drawn from the model's interfaces instead. */
  const CHOICE_ANNOTATIONS = ['patterns', 'styles', 'tactics'];

  function annotationsOf(element, kinds) {
    const { choices } = element;
    if (!choices) return [];
    return kinds.flatMap((kind) => (kind === 'patterns'
      ? choices.patterns.filter((choice) => choice.pattern).map((choice) => (choice.role ? `${choice.pattern}: ${choice.role}` : choice.pattern))
      : choices[kind]));
  }

  function groupBoundaryId(model, element) {
    if (!element.group) return null;
    const key = `${element.parentId || ''}/${element.group}`;
    return model.groups.has(key) ? GROUP_BOUNDARY_PREFIX + key : null;
  }

  function nearestBoundaryAncestor(model, element, boundaryIds) {
    for (let ancestor = model.elements.get(element.parentId); ancestor; ancestor = model.elements.get(ancestor.parentId)) {
      if (boundaryIds.has(ancestor.id)) return ancestor.id;
    }
    return null;
  }

  /** The boundary drawn directly around an element outside any group: an ancestor's boundary, else the enterprise. */
  function enclosingBoundary(model, element, view) {
    const ancestor = nearestBoundaryAncestor(model, element, view.boundaryIds);
    if (ancestor) return ancestor;
    return view.enterprise && element.inEnterprise ? ENTERPRISE_BOUNDARY_ID : null;
  }

  /** The interfaces a node provides (spec §5.2 item 10, §5.3 rule 1). */
  function nodeInterfaces(model, element) {
    return providedInterfaces(model, element.id).map(({ interfaceId, name, declaredOnName, delegatedFromName }) =>
      ({ interfaceId, name, declaredOnName, delegatedFromName }));
  }

  function nodeOf(model, element, view) {
    const groupId = groupBoundaryId(model, element);
    return {
      id: element.id, type: element.type, kind: element.kind, name: element.name, typeLabel: typeLabel(element),
      technology: element.technology, lines: boxLines(element), external: element.external, inEnterprise: element.inEnterprise,
      groupId, boundaryId: groupId || enclosingBoundary(model, element, view), drill: drillTarget(model, element.id),
      annotations: annotationsOf(element, view.annotations.filter((kind) => CHOICE_ANNOTATIONS.includes(kind))),
      interfaces: view.annotations.includes('interfaces') ? nodeInterfaces(model, element) : [],
      pinAdjusted: false,
    };
  }

  function boundaryOf(id, kind, label, boundaryTypeLabel, parentBoundaryId, nodes) {
    return { id, kind, label, typeLabel: boundaryTypeLabel, parentBoundaryId,
      memberIds: nodes.filter((node) => node.boundaryId === id).map((node) => node.id) };
  }

  /** Enterprise, scope and element boundaries, then groups; the enterprise boundary only when it has members. */
  function boundariesOf(model, nodes, view) {
    const boundaries = [];
    if (view.enterprise && nodes.some((node) => node.boundaryId === ENTERPRISE_BOUNDARY_ID)) {
      boundaries.push(boundaryOf(ENTERPRISE_BOUNDARY_ID, 'enterprise', model.meta.enterprise, 'Enterprise', null, nodes));
    }
    [...view.boundaryIds].map((id) => model.elements.get(id)).forEach((element) => {
      const kind = element.id === view.scopeBoundaryId ? 'scope' : element.type;
      boundaries.push(boundaryOf(element.id, kind, element.name, typeLabel(element), enclosingBoundary(model, element, view), nodes));
    });
    const groupIds = [...new Set(nodes.map((node) => node.groupId).filter(Boolean))];
    groupIds.forEach((id) => {
      const group = model.groups.get(id.slice(GROUP_BOUNDARY_PREFIX.length));
      const members = nodes.filter((node) => node.groupId === id);
      const parentId = group.scopeId && view.boundaryIds.has(group.scopeId) ? group.scopeId
        : (view.enterprise && members.every((node) => node.inEnterprise) ? ENTERPRISE_BOUNDARY_ID : null);
      boundaries.push(boundaryOf(id, 'group', group.name, 'Group', parentId, nodes));
    });
    return boundaries;
  }

  function nodeLegendKey(node) {
    if (node.type === 'person') return 'person';
    if (node.type === 'system') return node.external ? 'external' : 'system';
    if (node.type === 'container') return node.kind === 'application' ? 'container' : node.kind;
    return node.type;
  }

  /** The legend entries actually used, in the fixed legend order. */
  function legendOf(nodes, boundaries, edges) {
    const used = new Set(nodes.map(nodeLegendKey));
    if (nodes.some((node) => node.external)) used.add('external');
    boundaries.forEach((boundary) => used.add({ group: 'group', enterprise: 'enterprise' }[boundary.kind] || 'boundary-scope'));
    if (edges.some((edge) => edge.async)) used.add('async');
    if (edges.some((edge) => edge.unassigned)) used.add('unassigned');
    return LEGEND.filter(([key]) => used.has(key)).map(([key, label]) => ({ key, label }));
  }

  function projectC4View(model, request, base, custom) {
    const selection = selectElements(model, base, custom ? custom.include : []);
    // Excluded elements leave before neighbours and covered landings are worked out, so they pull nothing in.
    const excluded = new Set(custom ? custom.exclude : []);
    const lifted = liftRelationships(model, selection).filter((edge) => !excluded.has(edge.sourceId) && !excluded.has(edge.targetId));
    const shown = lifted.filter((edge) => !isCoveredLanding(model, edge, lifted));
    const kept = keptElements(shown, selection);
    excluded.forEach((id) => kept.delete(id));
    const visible = (id) => kept.has(id) || selection.boundaryIds.has(id);
    const view = {
      type: base.type, scopeBoundaryId: selection.scopeBoundaryId, boundaryIds: selection.boundaryIds,
      enterprise: ENTERPRISE_VIEWS.includes(base.type) && model.meta.enterprise !== null,
      annotations: effectiveAnnotations(request, base, custom),
    };
    const hidesDerived = Boolean(custom) && !custom.derived;
    const edges = mergeEdges(model, shown.filter((edge) => visible(edge.sourceId) && visible(edge.targetId)), view)
      .filter((edge) => !(hidesDerived && edge.derived));
    const nodes = [...model.elements.values()]
      .filter((element) => kept.has(element.id))
      .map((element) => nodeOf(model, element, view));
    const boundaries = boundariesOf(model, nodes, view);
    const scope = base.scopeId ? model.elements.get(base.scopeId) : null;
    return {
      key: request.base, selector: request.canonical, annotations: view.annotations, type: base.type, scopeId: base.scopeId, notation: 'c4',
      title: (custom && custom.title) || (scope ? scopedTitle(base.type, scope) : 'System landscape'),
      description: custom ? custom.description : null,
      nodes, boundaries, edges, legend: legendOf(nodes, boundaries, edges),
      breadcrumbs: breadcrumbs(model, request), elementCount: nodes.length, large: nodes.length > LARGE_VIEW_THRESHOLD,
      uml: null, card: null, direction: directionOf(custom), diagnostics: [],
    };
  }

  // ---- Scenario steps (spec §6.3) -------------------------------------------------------------

  const DELIVERING_KINDS = ['queue', 'topic'];

  function isSameOrInside(model, id, ancestorId) {
    return id === ancestorId || contains(model, ancestorId, id);
  }

  /** Relationships running from `fromId` to `toId`: declared between them, or derived from elements nested inside either end. */
  function relationshipsAlong(model, fromId, toId) {
    return model.relationships.filter((relationship) => isSameOrInside(model, relationship.sourceId, fromId)
      && isSameOrInside(model, relationship.targetId, toId));
  }

  function idsOf(relationships) {
    return relationships.map((relationship) => relationship.id);
  }

  function stepStatus(status, relationships) {
    return { kind: 'message', status, relationshipIds: idsOf(relationships), reason: null, reasonCode: null };
  }

  /** An invalid step, with why as a stable code (UML-view editing spec §4.3) and as a sentence. */
  function invalidStep(reasonCode, reason) {
    return { kind: 'message', status: 'invalid', relationshipIds: [], reason, reasonCode };
  }

  /** A step is asynchronous when its own connector is, or, without one, when every relationship it runs along is. */
  function isAsynchronousStep(step, relationships) {
    if (step.connector) return schema.ASYNC_CONNECTORS.includes(step.connector);
    return relationships.every((relationship) => relationship.async);
  }

  const requestKey = (fromId, toId) => `${fromId}->${toId}`;

  function openRequest(openRequests, fromId, toId) {
    const key = requestKey(fromId, toId);
    openRequests.set(key, (openRequests.get(key) || 0) + 1);
  }

  /** Consumes one unanswered request from `fromId` to `toId`; false when there is none. */
  function answerRequest(openRequests, fromId, toId) {
    const key = requestKey(fromId, toId);
    const count = openRequests.get(key) || 0;
    if (count === 0) return false;
    openRequests.set(key, count - 1);
    return true;
  }

  function isDelivering(model, id) {
    const element = model.elements.get(id);
    return element.type === 'container' && DELIVERING_KINDS.includes(element.kind);
  }

  /** A step that runs against its relationships: a reply to an open synchronous request, a queue or topic delivery, or invalid. */
  function classifyBackwardStep(model, step, openRequests) {
    const { from, to } = step;
    const backward = relationshipsAlong(model, to, from);
    const synchronous = backward.filter((relationship) => !relationship.async);
    if (synchronous.length > 0 && answerRequest(openRequests, to, from)) return stepStatus('reply', synchronous);
    if (backward.length > 0 && isDelivering(model, from)) return stepStatus('delivery', backward);
    if (synchronous.length > 0) {
      return invalidStep('reply-without-request', `${from} replies to ${to}, but no earlier unanswered step from ${to} to ${from} precedes it; ` +
        `add that request first, or declare the relationship ${from} → ${to}`);
    }
    if (backward.length > 0) {
      return invalidStep('asynchronous-no-reply',
        `${to} → ${from} is asynchronous, so ${from} cannot reply over it; declare the relationship ${from} → ${to}`);
    }
    return invalidStep('no-relationship', `No relationship runs between ${from} and ${to}; declare the relationship ${from} → ${to}`);
  }

  function classifyMessage(model, step, openRequests) {
    const unknown = [step.from, step.to].filter((id) => !model.elements.has(id));
    if (unknown.length > 0) return invalidStep('unknown-element', `${unknown.join(' and ')} is not an element of the model`);
    const forward = relationshipsAlong(model, step.from, step.to);
    if (forward.length === 0) return classifyBackwardStep(model, step, openRequests);
    if (isAsynchronousStep(step, forward)) return stepStatus('async', forward);
    openRequest(openRequests, step.from, step.to);
    return stepStatus('forward', forward);
  }

  /** Each branch starts from a copy of the requests open where the fragment begins; the steps after it keep the original. */
  function classifyStepList(model, steps, openRequests) {
    return steps.map((step) => (step.kind === 'fragment'
      ? { kind: 'fragment', operator: step.operator,
        branches: step.branches.map((branch) => ({ when: branch.when, steps: classifyStepList(model, branch.steps, new Map(openRequests)) })) }
      : classifyMessage(model, step, openRequests)));
  }

  /**
   * Classifies a scenario's steps (spec §6.3), mirroring its step tree: a message step becomes
   * `{ kind: 'message', status, relationshipIds, reason, reasonCode }`, a fragment `{ kind: 'fragment', operator, branches: [{ when, steps }] }`.
   * An invalid step's `reasonCode` is `no-relationship`, `reply-without-request`, `asynchronous-no-reply`, or `unknown-element`,
   * and its `reason` says the same in a sentence; both are null for a valid step.
   */
  function classifySteps(model, scenarioId) {
    const scenario = model.scenarios.get(scenarioId);
    if (!scenario) throw new Error(`classifySteps: there is no scenario named ${scenarioId}`);
    return classifyStepList(model, scenario.steps, new Map());
  }

  // ---- UML view models (spec §6.3) ------------------------------------------------------------

  const CODE_KEYWORDS = { function: 'function', module: 'module' };
  const C4_KEYWORDS = { person: 'person', system: 'software system', container: 'container', component: 'component' };
  const ARROWS = { forward: 'sync', invalid: 'sync', reply: 'reply', async: 'async', delivery: 'async' };

  /** A code element of the component; a function that declares no operation is drawn with its own call (`synthesizedOperations`). */
  function codeClass(element) {
    const { operations, attributes } = element.code;
    const synthesizedOperations = element.kind === 'function' && operations.length === 0;
    return { id: element.id, name: element.name, kind: element.kind, keyword: CODE_KEYWORDS[element.kind] || null,
      attributes, operations: synthesizedOperations ? [`${element.name}()`] : operations, external: false,
      lifted: false, synthesizedOperations };
  }

  /** An element from outside the component, drawn as one box with its C4 keyword. */
  function liftedClass(element) {
    return { id: element.id, name: element.name, kind: 'class', keyword: C4_KEYWORDS[element.type], attributes: [], operations: [],
      external: Boolean(element.external), lifted: true, synthesizedOperations: false };
  }

  /**
   * The element that stands for `id` beside `scope`: `id`'s ancestor-or-self that is a child of their lowest common
   * ancestor, or `id`'s top-level element when they share none (a sibling, another container, another system, or a
   * person); a part of `scope` lifts to the child of `scope` that contains it. Null when `id` is `scope` or one of its ancestors.
   */
  function liftBeside(model, scope, id) {
    const chain = lineage(model, model.elements.get(id));
    const scopeChain = lineage(model, scope);
    return chain.find((element, index) => !scopeChain[index] || element.id !== scopeChain[index].id) || null;
  }

  /**
   * The class diagram of a component. A relation is drawn between the boxes that stand for its declared ends
   * (`modelSourceId`, `modelTargetId`); `lifted` says which drawn end stands for a deeper declared element, and
   * `relationshipId` names the relationship behind a dependency (null for extends and implements).
   */
  function projectClassDiagram(model, component) {
    const codeElements = component.childIds.map((id) => model.elements.get(id));
    const classes = codeElements.map(codeClass);
    const drawnIds = new Set(classes.map((entry) => entry.id));
    /** The id of the class a reference draws, adding a lifted class on first use; null when nothing stands for it. */
    const draw = (id) => {
      const element = liftBeside(model, component, id);
      if (!element) return null;
      if (!drawnIds.has(element.id)) {
        drawnIds.add(element.id);
        classes.push(liftedClass(element));
      }
      return element.id;
    };
    const relations = [];
    const addRelation = ({ type, modelSourceId, modelTargetId, label = null, relationshipId = null }) => {
      const sourceId = draw(modelSourceId);
      const targetId = draw(modelTargetId);
      if (!sourceId || !targetId) return;
      relations.push({ type, sourceId, targetId, label, relationshipId, modelSourceId, modelTargetId,
        lifted: { source: sourceId !== modelSourceId, target: targetId !== modelTargetId } });
    };
    // Unknown extends and implements targets, and targets that are the component or its ancestors, are already
    // reported by the model and are left out here.
    codeElements.forEach((element) => ['extends', 'implements'].forEach((type) => element.code[type]
      .filter((targetId) => model.elements.has(targetId))
      .forEach((targetId) => addRelation({ type, modelSourceId: element.id, modelTargetId: targetId }))));
    model.relationships
      .filter((relationship) => [relationship.sourceId, relationship.targetId].some((id) => contains(model, component.id, id)))
      .forEach((relationship) => addRelation({ type: 'dependency', modelSourceId: relationship.sourceId, modelTargetId: relationship.targetId,
        label: relationship.description, relationshipId: relationship.id }));
    return { name: component.name, elementCount: classes.length, uml: { classes, relations } };
  }

  /** The technology a step names, else the one every relationship backing it shares. */
  function stepTechnology(model, step, status) {
    if (step.technology) return step.technology;
    const technologies = new Set(model.relationships.filter((relationship) => status.relationshipIds.includes(relationship.id))
      .map((relationship) => relationship.technology));
    return technologies.size === 1 ? [...technologies][0] : null;
  }

  /** Step statuses whose backing relationships the step itself follows; a reply answers a call instead of making one. */
  const CALLING_STATUSES = ['forward', 'async', 'delivery'];

  /** The one operation every use of the step's backing relationships names; null for none, several, or a whole interface. */
  function backingOperationUse(model, status) {
    if (!CALLING_STATUSES.includes(status.status)) return null;
    const uses = model.relationships.filter((relationship) => status.relationshipIds.includes(relationship.id))
      .flatMap((relationship) => relationship.uses);
    if (uses.length === 0 || uses.some((use) => use.operationId === null)) return null;
    const operations = new Set(uses.map((use) => `${use.interfaceId}.${use.operationId}`));
    return operations.size === 1 ? uses[0] : null;
  }

  /** The operation a message step uses (spec §5.2 item 12): its own `uses`, else its backing relationships' single operation. */
  function stepOperation(model, step, status) {
    const use = step.uses || backingOperationUse(model, status);
    if (!use) return null;
    const declared = interfaceById(model, use.interfaceId);
    const operation = declared.operations.find((candidate) => candidate.id === use.operationId);
    return { interfaceId: declared.id, operationId: operation.id, syntax: operation.syntax };
  }

  /** A message item; `step` is the place of its step, and `status`, `reasonCode`, and `relationshipIds` its classification. */
  function messageItem({ model, annotated }, step, status, place) {
    const technology = stepTechnology(model, step, status);
    const description = step.description || '';
    const operation = annotated ? stepOperation(model, step, status) : null;
    const label = technology ? `${description} [${technology}]` : description;
    return { type: 'message', from: step.from, to: step.to, label: operation ? `${label} (${operation.syntax})` : label,
      arrow: ARROWS[status.status], operation,
      step: place, status: status.status, reasonCode: status.reasonCode, relationshipIds: status.relationshipIds };
  }

  /**
   * The container path of a fragment branch's step list, in the form the scenario commands take (C4 spec §4.8):
   * `[index, operator]` for opt, loop, and break, `[index, operator, branch]` for alt and par, joined by 'steps' when nested.
   */
  function branchPath(containerPath, index, operator, branchIndex) {
    const own = schema.MULTI_BRANCH_FRAGMENTS.includes(operator) ? [index, operator, branchIndex] : [index, operator];
    return containerPath.length > 0 ? containerPath.concat('steps', own) : own;
  }

  /**
   * Sequence items for steps whose ends are elements; steps naming unknown elements are already reported by the model.
   * In a view annotated with interfaces (`context.annotated`), messages name the operation they use. Each message and
   * fragment carries `step: { containerPath, index }`, its place in the model's step tree, so a step left out of the
   * drawing shifts no place after it; each branch carries its `index`, the `containerPath` of its step list, and
   * `stepCount`, the number of steps the model lists in it, drawn or not (the end of the branch, §4.1 anchors).
   */
  function sequenceItems(context, steps, statuses, containerPath = []) {
    return steps.flatMap((step, index) => {
      const status = statuses[index];
      const place = { containerPath: containerPath.slice(), index };
      if (step.kind === 'fragment') {
        return [{ type: 'fragment', operator: step.operator, step: place, branches: step.branches.map((branch, branchIndex) => {
          const branchContainer = branchPath(containerPath, index, step.operator, branchIndex);
          return { guard: branch.when, index: branchIndex, containerPath: branchContainer, stepCount: branch.steps.length,
            items: sequenceItems(context, branch.steps, status.branches[branchIndex].steps, branchContainer) };
        }) }];
      }
      const drawn = context.model.elements.has(step.from) && context.model.elements.has(step.to);
      return drawn ? [messageItem(context, step, status, place)] : [];
    });
  }

  function participantIdsOf(items, ids = []) {
    items.forEach((item) => {
      if (item.type === 'fragment') item.branches.forEach((branch) => participantIdsOf(branch.items, ids));
      else [item.from, item.to].filter((id) => !ids.includes(id)).forEach((id) => ids.push(id));
    });
    return ids;
  }

  /** The box around a lifeline: the nearest container of a component or code element, the system of a container. */
  function lifelineBox(model, element) {
    if (element.type === 'container') return model.elements.get(element.parentId);
    if (element.type !== 'component' && element.type !== 'code') return null;
    return lineage(model, element).find((ancestor) => ancestor.type === 'container');
  }

  /** The sequence diagram of a scenario; `stepCount` is the number of its top-level steps, drawn or not (its end, §4.1 anchors). */
  function projectSequenceDiagram(model, scenario, annotated) {
    const items = sequenceItems({ model, annotated }, scenario.steps, classifySteps(model, scenario.id));
    const lifelines = participantIdsOf(items).map((id) => model.elements.get(id));
    const boxes = [];
    const participants = lifelines.map((element) => {
      const box = lifelineBox(model, element);
      if (box && !boxes.some((entry) => entry.id === box.id)) {
        boxes.push({ id: box.id, label: box.name, external: Boolean(lineage(model, box)[0].external) });
      }
      return { id: element.id, name: element.name, kind: element.type === 'person' ? 'actor' : 'participant', boxId: box ? box.id : null };
    });
    return { name: scenario.title || scenario.id, elementCount: participants.length,
      uml: { participants, boxes, items, stepCount: scenario.steps.length } };
  }

  function environmentNodesInOrder(environment, ids = environment.rootNodeIds, ordered = []) {
    ids.forEach((id) => {
      const node = environment.nodes.get(id);
      ordered.push(node);
      environmentNodesInOrder(environment, node.childIds, ordered);
    });
    return ordered;
  }

  /**
   * One instance per hosting node, naming that node (`nodeId`). An element hosted once is named by its id, unless a
   * node has that id; otherwise each instance is named `<element>@<node>`.
   */
  function hostedInstances(model, environment, nodes) {
    const hostCount = new Map();
    nodes.forEach((node) => node.hosts.forEach((id) => hostCount.set(id, (hostCount.get(id) || 0) + 1)));
    const instanceId = (elementId, nodeId) => (hostCount.get(elementId) === 1 && !environment.nodes.has(elementId)
      ? elementId : `${elementId}@${nodeId}`);
    return new Map(nodes.map((node) => [node.id, node.hosts.map((elementId) => {
      const element = model.elements.get(elementId);
      return { instanceId: instanceId(elementId, node.id), elementId, name: element.name, type: element.type, nodeId: node.id };
    })]));
  }

  /** The instances an endpoint runs on: those of its nearest hosted ancestor-or-self. */
  function instancesOf(model, instancesByElement, id) {
    for (let element = model.elements.get(id); element; element = model.elements.get(element.parentId)) {
      if (instancesByElement.has(element.id)) return instancesByElement.get(element.id);
    }
    return [];
  }

  /**
   * Relationships lifted to the hosted instances, merged per instance pair and synchrony as in spec §5.2 step 5. A derived
   * link lists every relationship it merges, in model order (`relationshipIds`); its label is the first one's description.
   */
  function derivedLinks(model, instances) {
    const instancesByElement = new Map();
    instances.forEach((instance) => {
      if (!instancesByElement.has(instance.elementId)) instancesByElement.set(instance.elementId, []);
      instancesByElement.get(instance.elementId).push(instance);
    });
    const groups = new Map();
    model.relationships.forEach((relationship) => {
      instancesOf(model, instancesByElement, relationship.sourceId).forEach((source) => {
        instancesOf(model, instancesByElement, relationship.targetId).forEach((target) => {
          if (source.elementId === target.elementId) return;
          const key = `${source.instanceId}->${target.instanceId}/${relationship.async}`;
          if (!groups.has(key)) groups.set(key, { sourceId: source.instanceId, targetId: target.instanceId, relationships: [] });
          groups.get(key).relationships.push(relationship);
        });
      });
    });
    return [...groups.values()].map(({ sourceId, targetId, relationships }) => {
      const [first, ...rest] = relationships;
      return {
        sourceId, targetId, label: first.description,
        technology: rest.every((relationship) => relationship.technology === first.technology) ? first.technology : null,
        async: first.async, derived: true, relationshipIds: idsOf(relationships),
      };
    });
  }

  function projectDeploymentDiagram(model, environment) {
    const environmentNodes = environmentNodesInOrder(environment);
    const hostedByNode = hostedInstances(model, environment, environmentNodes);
    const nodes = environmentNodes.map((node) => ({
      id: node.id, name: node.name, kind: node.kind, technology: node.technology, instances: node.instances,
      parentId: node.parentId, hosted: hostedByNode.get(node.id),
    }));
    const instances = nodes.flatMap((node) => node.hosted);
    // A link between nodes is declared on the node (a collaborator), so it is not derived and merges no relationship.
    const nodeLinks = environmentNodes.flatMap((node) => node.relationships.map((link) => ({
      sourceId: node.id, targetId: link.targetId, label: link.description, technology: link.technology, async: false,
      derived: false, relationshipIds: [] })));
    const hostOf = new Map(nodes.flatMap((node) => node.hosted.map((instance) => [instance.instanceId, node.id])));
    const unrouted = derivedLinks(model, instances)
      .filter((link) => !isRouted(nodeLinks, hostOf.get(link.sourceId), hostOf.get(link.targetId)));
    return { name: environment.name, elementCount: nodes.length + instances.length, uml: { nodes, links: unrouted.concat(nodeLinks) } };
  }

  /**
   * True when explicit node links lead from node `fromId` to node `toId`, directly or through other nodes (spec §6.3):
   * the derived link between instances on those nodes would then repeat the route already drawn.
   */
  function isRouted(nodeLinks, fromId, toId) {
    const visited = new Set();
    const pending = [fromId];
    while (pending.length > 0) {
      const nodeId = pending.shift();
      for (const link of nodeLinks.filter((candidate) => candidate.sourceId === nodeId)) {
        if (link.targetId === toId) return true;
        if (!visited.has(link.targetId)) {
          visited.add(link.targetId);
          pending.push(link.targetId);
        }
      }
    }
    return false;
  }

  const UML_PROJECTIONS = {
    code: { notation: 'uml-class', project: (model, scopeId) => projectClassDiagram(model, model.elements.get(scopeId)) },
    dynamic: { notation: 'uml-sequence',
      project: (model, scopeId, annotations) => projectSequenceDiagram(model, model.scenarios.get(scopeId), annotations.includes('interfaces')) },
    deployment: { notation: 'uml-deployment', project: (model, scopeId) => projectDeploymentDiagram(model, model.environments.get(scopeId)) },
  };

  /**
   * The layout entry of a UML-notation view (UML-view editing spec §4.2) as a copy `{ positions, routes, lifelines }`, or
   * null when the design keeps none for the view's key.
   */
  function umlLayout(model, key) {
    const entry = model.layout.get(key);
    if (!entry) return null;
    return {
      positions: new Map([...entry.positions].map(([id, point]) => [id, point.slice()])),
      routes: entry.routes.map((route) => Object.assign({}, route, { points: route.points.map((point) => point.slice()) })),
      lifelines: entry.lifelines.slice(),
    };
  }

  /**
   * A code, dynamic, or deployment view: the C4 fields stay empty and `uml` carries the diagram's model. `layout` is the
   * view's layout entry (UML-view editing spec §4.2), or null.
   */
  function projectUmlView(model, request, base, custom) {
    const { notation, project } = UML_PROJECTIONS[base.type];
    const annotations = effectiveAnnotations(request, base, custom);
    const { name, elementCount, uml } = project(model, base.scopeId, annotations);
    return {
      key: request.base, selector: request.canonical, annotations, type: base.type, scopeId: base.scopeId, notation,
      title: (custom && custom.title) || `${TITLE_PREFIXES[base.type]}: ${name}`,
      description: custom ? custom.description : null,
      nodes: [], boundaries: [], edges: [], legend: [],
      breadcrumbs: breadcrumbs(model, request), elementCount, large: elementCount > LARGE_VIEW_THRESHOLD,
      uml, card: null, direction: directionOf(custom), diagnostics: [], layout: umlLayout(model, request.base),
    };
  }

  // ---- Interfaces view: `interfaces of E` (spec §5.3 rules 1–6) ----------------------------------

  /** Syntax lines shown in an assembly label before the rest are counted (spec §5.3 rule 4). */
  const LABELLED_OPERATIONS = 2;

  /** The line a client writes to call an operation: its syntax, else its id. */
  function syntaxLine(operation) {
    return operation.syntax === null ? operation.id : operation.syntax;
  }

  /** The operations a set of uses names, in document order; none for a whole-interface use, which names them all. */
  function usedOperations(declared, uses) {
    if (uses.some((use) => use.operationId === null)) return [];
    return declared.operations.filter((operation) => uses.some((use) => use.operationId === operation.id));
  }

  /**
   * Every request or broker-peer use from the element or its parts to the outside (spec §5.3 rule 2), with the
   * interface's provider lifted to the element's level of abstraction, as `{ interfaceId, elementId, throughId, use }`.
   */
  function requiringUses(model, elementId) {
    const scope = model.elements.get(elementId);
    return model.relationships
      .filter((relationship) => isSameOrInside(model, relationship.sourceId, elementId)
        && !isSameOrInside(model, relationship.targetId, elementId))
      .flatMap((relationship) => relationship.uses.filter((use) => REQUIRING_KINDS.includes(use.kind)).flatMap((use) => {
        const { providerId } = model.interfaces.get(use.interfaceId);
        const lifted = isSameOrInside(model, providerId, elementId) ? null : liftBeside(model, scope, providerId);
        return lifted ? [{ interfaceId: use.interfaceId, elementId: lifted.id, throughId: throughIdOf(relationship, use), use }] : [];
      }));
  }

  /** "<syntax>, <syntax> (+N more)", then "(through <broker>)" for a broker-peer use; null when nothing is named. */
  function assemblyLabel(model, interfaceId, uses, throughId) {
    const operations = usedOperations(model.interfaces.get(interfaceId), uses);
    const shown = operations.slice(0, LABELLED_OPERATIONS).map(syntaxLine);
    const hidden = operations.length - shown.length;
    const parts = shown.length > 0 ? [shown.join(', ') + (hidden > 0 ? ` (+${hidden} more)` : '')] : [];
    if (throughId !== null) parts.push(`(through ${model.elements.get(throughId).name})`);
    return parts.length > 0 ? parts.join(' ') : null;
  }

  /** One assembly per (provider, interface, consumer, channel), sorted by interface, then by the other end's document position. */
  function assembliesOf(model, links, interfaceOrder, otherEnd) {
    const documentIndex = new Map([...model.elements.keys()].map((id, index) => [id, index]));
    const groups = new Map();
    links.forEach((link) => {
      const key = assemblyKey(link.interfaceId, link.providerId, link.consumerId, link.throughId);
      if (!groups.has(key)) groups.set(key, Object.assign({}, link, { uses: [] }));
      groups.get(key).uses.push(link.use);
    });
    const rank = (group) => [interfaceOrder.indexOf(group.interfaceId), documentIndex.get(group[otherEnd])];
    return [...groups.values()]
      .sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1])
      .map(({ interfaceId, providerId, consumerId, throughId, uses }) => ({
        interfaceId, providerId, consumerId, label: assemblyLabel(model, interfaceId, uses, throughId),
        throughId, throughName: throughId === null ? null : model.elements.get(throughId).name,
      }));
  }

  /** A box of the component diagram; `provides` and `requires` list the interfaces drawn on it. */
  function umlComponent(element, role, provides, requires) {
    return { id: element.id, name: element.name, typeLabel: typeLabel(element), role, external: element.external, provides, requires };
  }

  function uniqueInterfaces(model, interfaceIds) {
    return [...new Set(interfaceIds)].map((interfaceId) => ({ interfaceId, name: model.interfaces.get(interfaceId).name }));
  }

  /** What a consumer or provider box shows: the interfaces it requires from, or provides to, the scope. */
  function neighbourComponent(model, scopeId, element, role, assemblies) {
    const provided = assemblies.filter((assembly) => assembly.providerId === element.id && assembly.consumerId === scopeId);
    const required = assemblies.filter((assembly) => assembly.consumerId === element.id && assembly.providerId === scopeId);
    const provides = uniqueInterfaces(model, provided.map((assembly) => assembly.interfaceId)).map(({ interfaceId }) => {
      const declared = model.interfaces.get(interfaceId);
      return providedEntry(model, declared, declared.providerId === element.id ? null : declared.providerId, null);
    });
    return umlComponent(element, role, provides, uniqueInterfaces(model, required.map((assembly) => assembly.interfaceId)));
  }

  /** The people among the consumers, each with the interfaces it uses (spec §5.3 rule 3). */
  function peopleOf(model, personUses) {
    const people = new Map();
    personUses.forEach(({ elementId, interfaceId }) => {
      if (!people.has(elementId)) people.set(elementId, []);
      people.get(elementId).push(interfaceId);
    });
    return [...people].map(([id, interfaceIds]) => ({ id, name: model.elements.get(id).name, interfaceIds: [...new Set(interfaceIds)] }));
  }

  /** The person note, then one note per interface offered through a part, then one per delegated interface (spec §5.3 rule 6). */
  function notesOf(scope, provided, people) {
    const notes = [];
    if (people.length > 0) notes.push(`Also used directly by ${people.map((person) => `${person.name} (person)`).join(', ')}.`);
    provided.filter((entry) => entry.declaredOnId !== null)
      .forEach((entry) => notes.push(`${entry.name} is offered through ${entry.declaredOnName}.`));
    provided.filter((entry) => entry.delegatedFromId !== null)
      .forEach((entry) => notes.push(`${entry.name} belongs to ${entry.delegatedFromName}; ${scope.name} handles its calls.`));
    return notes;
  }

  /** Assemblies of the scope's provided interfaces with the consumers that are drawn (people are notes instead). */
  function providedAssemblies(model, scope, provided, consuming) {
    const links = consuming.filter((link) => !link.person)
      .map((link) => Object.assign({}, link, { providerId: scope.id, consumerId: link.elementId }));
    return assembliesOf(model, links, provided.map((entry) => entry.interfaceId), 'consumerId');
  }

  /** Assemblies of the scope's required interfaces with their providers, leaving out excluded providers. */
  function requiredAssemblies(model, scope, required, excluded) {
    const links = requiringUses(model, scope.id).filter((link) => !excluded.has(link.elementId))
      .map((link) => Object.assign({}, link, { providerId: link.elementId, consumerId: scope.id }));
    return assembliesOf(model, links, required.map((entry) => entry.interfaceId), 'providerId');
  }

  function projectInterfacesOf(model, scope, custom) {
    const excluded = new Set(custom ? custom.exclude : []);
    const provided = providedInterfaces(model, scope.id);
    const required = requiredInterfaces(model, scope.id);
    const consuming = consumingUses(model, scope.id).filter((link) => !excluded.has(link.elementId));
    const assemblies = providedAssemblies(model, scope, provided, consuming)
      .concat(requiredAssemblies(model, scope, required, excluded));
    const inDocumentOrder = (ids) => [...model.elements.values()].filter((element) => ids.has(element.id));
    const consumerIds = new Set(assemblies.filter((assembly) => assembly.providerId === scope.id).map((assembly) => assembly.consumerId));
    const providerIds = new Set(assemblies.filter((assembly) => assembly.consumerId === scope.id && !consumerIds.has(assembly.providerId))
      .map((assembly) => assembly.providerId));
    const people = peopleOf(model, consuming.filter((link) => link.person));
    const components = inDocumentOrder(consumerIds).map((element) => neighbourComponent(model, scope.id, element, 'consumer', assemblies))
      .concat(umlComponent(scope, 'scope', provided, required.map(({ interfaceId, name }) => ({ interfaceId, name }))),
        inDocumentOrder(providerIds).map((element) => neighbourComponent(model, scope.id, element, 'provider', assemblies)));
    const isEmpty = provided.length === 0 && required.length === 0;
    return {
      title: interfacesTitle(scope), elementCount: components.length, card: null,
      uml: {
        components, assemblies, people, notes: notesOf(scope, provided, people),
        emptyText: isEmpty ? `${scope.name} provides and uses no described interfaces yet.` : null,
        direction: directionOf(custom),
      },
    };
  }

  // ---- Interface description card: `interface I` (spec §5.3) -------------------------------------

  /** "<Style> interface · <technology> · version <version>", "Interface · <technology>" without a style. */
  function cardTypeLabel(declared) {
    if (declared.shorthand) return 'Interface · syntax only';
    const parts = [declared.style ? `${schema.STYLE_LABELS[declared.style]} interface` : 'Interface'];
    if (declared.technology) parts.push(declared.technology);
    if (declared.version) parts.push(`version ${declared.version}`);
    return parts.join(' · ');
  }

  /** `[{ elementId, operationIds }]`, once per element in first-use order; a whole-interface use lists no operation. */
  function operationsPerElement(declared, elementUses) {
    const usesById = new Map();
    elementUses.forEach(({ elementId, use }) => {
      if (!usesById.has(elementId)) usesById.set(elementId, []);
      usesById.get(elementId).push(use);
    });
    return [...usesById].map(([elementId, uses]) => ({ elementId, operationIds: usedOperations(declared, uses).map((operation) => operation.id) }));
  }

  /** Uses of the interface on relationships, in relationship order, as `{ relationship, use }`. */
  function usesOfInterface(model, declared) {
    return model.relationships.flatMap((relationship) => relationship.uses
      .filter((use) => use.interfaceId === declared.id).map((use) => ({ relationship, use })));
  }

  /** The elements that use the interface: the source of a request or broker-peer use, the subscriber of an emission. */
  function interfaceUsers(model, declared) {
    const users = usesOfInterface(model, declared)
      .map(({ relationship, use }) => ({ elementId: userOf(relationship, use), use }))
      .filter(({ elementId }) => elementId !== null);
    return operationsPerElement(declared, users).map(({ elementId, operationIds }) => {
      const element = model.elements.get(elementId);
      return { elementId, name: element.name, typeLabel: typeLabel(element), operationIds };
    });
  }

  /** The targets strictly below the provider of relationships that use the interface (its delegates, UML delegation). */
  function interfaceHandlers(model, declared) {
    const handled = usesOfInterface(model, declared)
      .filter(({ relationship }) => contains(model, declared.providerId, relationship.targetId))
      .map(({ relationship, use }) => ({ elementId: relationship.targetId, use }));
    return operationsPerElement(declared, handled).map(({ elementId, operationIds }) =>
      ({ elementId, name: model.elements.get(elementId).name, operationIds }));
  }

  function errorRows(errors) {
    return errors.map(({ name, code, when }) => ({ name, code, when }));
  }

  /** The name of the table that shows an operation's inline field map ("charge input"). */
  function inlineTypeName(operation, part) {
    return `${operation.id} ${part}`;
  }

  /** `{ typeText }` for a type expression, `{ typeName }` naming the table of an inline field map, or null. */
  function typeUseEntry(operation, part) {
    const typeUse = operation[part];
    if (typeUse === null) return null;
    return typeUse.fields ? { typeName: inlineTypeName(operation, part) } : { typeText: typeUse.typeText };
  }

  /** The responsibilities an operation realizes; unknown ids are reported by the model and left out. */
  function realizedResponsibilities(model, operation) {
    return operation.realizes.filter((id) => model.responsibilityById.has(id)).map((id) => {
      const { kind, text, ownerId } = model.responsibilityById.get(id);
      return { id, kind, text, ownerName: model.elements.get(ownerId).name };
    });
  }

  function operationEntry(model, operation) {
    return {
      id: operation.id, syntax: operation.syntax, placeholders: [...operation.placeholders],
      input: typeUseEntry(operation, 'input'), output: typeUseEntry(operation, 'output'),
      purpose: operation.purpose, sideEffects: [...operation.sideEffects], restrictions: [...operation.restrictions],
      errors: errorRows(operation.errors),
      examples: operation.examples.map(({ inputText, outputText, note }) => ({ inputText, outputText, note })),
      realizes: realizedResponsibilities(model, operation),
    };
  }

  function fieldRows(fields, pathParameters) {
    return fields.map((field) => ({
      name: field.name, typeText: field.typeText, required: field.required, inPath: pathParameters.has(field.name),
      values: field.values && field.values.map(({ value, meaning }) => ({ value, meaning })),
      constraints: [...field.constraints], meaning: field.meaning, unit: field.unit, format: field.format, example: field.example,
    }));
  }

  /** The placeholders of every operation whose input is the named type: the fields filled from the path (spec §4.11). */
  function namedTypePathParameters(declared, typeName) {
    return new Set(declared.operations
      .filter(({ input }) => input && input.type && !input.type.invalid && !input.type.list && input.type.name === typeName)
      .flatMap((operation) => operation.placeholders));
  }

  /** One table per inline field map (in operation order), then one per named type (spec §6.6 item 4). */
  function cardTypes(declared) {
    const inline = declared.operations.flatMap((operation) => ['input', 'output']
      .filter((part) => operation[part] && operation[part].fields)
      .map((part) => ({
        name: inlineTypeName(operation, part), description: null, owner: { operationId: operation.id, part },
        fields: fieldRows(operation[part].fields, new Set(part === 'input' ? operation.placeholders : [])),
      })));
    const named = [...declared.types.values()].map((type) => ({
      name: type.name, description: type.description, owner: null,
      fields: fieldRows(type.fields, namedTypePathParameters(declared, type.name)),
    }));
    return inline.concat(named);
  }

  /** The interface's own terms, then the model-wide ones (spec §4.11 vocabulary). */
  function cardVocabulary(model, declared) {
    const entry = (shared) => ({ term, meaning }) => ({ term, meaning, shared });
    return declared.vocabulary.map(entry(false)).concat(model.vocabulary.map(entry(true)));
  }

  function interfaceCard(model, declared) {
    const provider = model.elements.get(declared.providerId);
    return {
      id: declared.id, name: declared.name, typeLabel: cardTypeLabel(declared),
      style: declared.style, technology: declared.technology, version: declared.version,
      provider: { id: provider.id, name: provider.name, typeLabel: typeLabel(provider) },
      description: declared.description, shorthand: declared.shorthand, documentFormat: declared.documentFormat,
      usedBy: interfaceUsers(model, declared),
      handledBy: interfaceHandlers(model, declared),
      all: { restrictions: [...declared.restrictions], errors: errorRows(declared.errors) },
      operations: declared.operations.map((operation) => operationEntry(model, operation)),
      types: cardTypes(declared),
      vocabulary: cardVocabulary(model, declared),
    };
  }

  function projectInterfaceCard(model, declared) {
    return { title: interfaceTitle(declared), elementCount: 1, uml: null, card: interfaceCard(model, declared) };
  }

  const INTERFACE_PROJECTIONS = {
    interfaces: { notation: 'uml-component', scopeIdOf: (model, base) => base.scopeId,
      project: (model, base, custom) => projectInterfacesOf(model, model.elements.get(base.scopeId), custom) },
    interface: { notation: 'interface-card', scopeIdOf: (model, base) => interfaceById(model, base.interfaceId).id,
      project: (model, base) => projectInterfaceCard(model, interfaceById(model, base.interfaceId)) },
  };

  /**
   * An interfaces view or an interface card: the C4 fields stay empty; `uml` or `card` carries the content. An interfaces
   * view, a UML-notation view, also has `layout` (as `projectUmlView`); a card has none.
   */
  function projectInterfaceView(model, request, base, custom) {
    const { notation, scopeIdOf, project } = INTERFACE_PROJECTIONS[base.type];
    const { title, elementCount, uml, card } = project(model, base, custom);
    const view = {
      key: request.base, selector: request.canonical, annotations: effectiveAnnotations(request, base, custom),
      type: base.type, scopeId: scopeIdOf(model, base), notation,
      title: (custom && custom.title) || title,
      description: custom ? custom.description : null,
      nodes: [], boundaries: [], edges: [], legend: [],
      breadcrumbs: breadcrumbs(model, request), elementCount, large: elementCount > LARGE_VIEW_THRESHOLD,
      uml, card, direction: directionOf(custom), diagnostics: [],
    };
    return notation === 'uml-component' ? Object.assign(view, { layout: umlLayout(model, request.base) }) : view;
  }

  return {
    parseSelector, canonicalSelector, resolveView, listViews, defaultView, breadcrumbs, drillTarget, projectView, classifySteps, errorView,
    providedInterfaces, requiredInterfaces, interfaceConsumers, summarizedBy,
  };
});
