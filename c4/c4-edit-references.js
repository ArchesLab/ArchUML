(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-schema.js'), require('./c4-yaml.js'), require('./c4-model.js'),
      require('./c4-edit-splices.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.editReferences = factory(parts.schema, parts.yaml, parts.model, parts.editSplices);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, yamlAdapter, modelApi, splicesModule) {
  'use strict';

  // Where a design names elements, responsibilities, and interfaces (spec §4.10, §4.11): the reference sites, the
  // edits that rename them, and the dependents that a delete or a move removes; with the lookups they rest on
  // (containment, and interfaces by id ignoring case).

  const { valueAt, isMap, hasOwn, fieldOf, startsWith, entryOffset } = splicesModule;

  // ---- Lookups -------------------------------------------------------------------------------

  function isAncestor(model, ancestorId, id) {
    for (let current = model.elements.get(id).parentId; current !== null; current = model.elements.get(current).parentId) {
      if (current === ancestorId) return true;
    }
    return false;
  }

  /** The interface with `id`, compared ignoring case; null when there is none. */
  function findInterface(model, id) {
    if (model.interfaces.has(id)) return model.interfaces.get(id);
    const lower = id.toLowerCase();
    return [...model.interfaces.values()].find((declared) => declared.id.toLowerCase() === lower) || null;
  }

  /** The element's shorthand interface (whose id is the element's id), or null. */
  function shorthandInterfaceOf(model, elementId) {
    const declared = model.interfaces.get(elementId);
    return declared && declared.shorthand && declared.providerId === elementId ? declared : null;
  }

  /** True when an interface that `isOwn` does not accept already has the id `id`, ignoring case. */
  function interfaceIdTaken(model, id, isOwn) {
    const lower = id.toLowerCase();
    return [...model.interfaces.values()].some((candidate) => !isOwn(candidate) && candidate.id.toLowerCase() === lower);
  }

  // ---- Dependents ----------------------------------------------------------------------------

  /**
   * The references a delete of `elementId` removes, in document order: `{ kind, path, label }`, where `path` is the
   * entry that goes. References inside the deleted subtree go with it and are not listed. With `newParentId`, the
   * references a move of the element under that parent removes instead (spec §4.10).
   */
  function dependentsOf(design, elementId, { newParentId = null } = {}) {
    if (!design.model.elements.has(elementId)) return [];
    if (newParentId !== null && !design.model.elements.has(newParentId)) return [];
    const found = newParentId === null ? dependents(design, elementId) : moveDependents(design, elementId, newParentId);
    return found.map(listedDependent);
  }

  /** The `uses` entries (of relationships and scenario steps) that name the interface, in document order (spec §4.10). */
  function interfaceDependentsOf(design, interfaceId) {
    const declared = typeof interfaceId === 'string' ? findInterface(design.model, interfaceId) : null;
    return declared ? usesSites(design, declared.id, null).map(listedDependent) : [];
  }

  /**
   * The stored view selectors that open the description card of the interface `interfaceId` (`interface ‹id›`, with
   * the id in any letter case, and its `of ‹element›` form): the initial `view` and the `view` of each custom view, in
   * document order, as `{ path, label }` (UML-view editing spec §5.1, the first-rename rule of an interface).
   */
  function interfaceSelectorsOf(design, interfaceId) {
    const declared = typeof interfaceId === 'string' ? findInterface(design.model, interfaceId) : null;
    if (!declared) return [];
    const id = declared.id.toLowerCase();
    return referenceSites(design).filter((site) => site.kind === 'view' && site.cardInterfaceId === id)
      .sort((a, b) => entryOffset(design.parsed, a.path) - entryOffset(design.parsed, b.path))
      .map(({ path, label }) => ({ path, label }));
  }

  function listedDependent({ kind, removalPath, label }) {
    return { kind, path: removalPath, label };
  }

  function dependents(design, elementId) {
    const { model } = design;
    const subtree = subtreeOf(model, elementId);
    const removedIds = {
      element: subtree,
      responsibility: new Set([...model.responsibilityById.values()]
        .filter((responsibility) => subtree.has(responsibility.ownerId)).map((responsibility) => responsibility.id)),
      interface: new Set([...model.interfaces.values()]
        .filter((declared) => subtree.has(declared.providerId)).map((declared) => declared.id.toLowerCase())),
    };
    const elementPath = model.elements.get(elementId).path;
    const named = referenceSites(design).filter((reference) => reference.removalPath !== null && !startsWith(reference.path, elementPath) &&
      reference.ids.some((id) => removedIds[reference.target].has(id)));
    return outermostInOrder(design.parsed, named);
  }

  /** Each removal path once, without those inside another, ordered by where they stand in the document. */
  function outermostInOrder(parsed, references) {
    const unique = new Map(references.map((reference) => [JSON.stringify(reference.removalPath), reference]));
    const outermost = [...unique.values()].filter((reference) => !references.some((other) =>
      other.removalPath.length < reference.removalPath.length && startsWith(reference.removalPath, other.removalPath)));
    return outermost.sort((a, b) => entryOffset(parsed, a.removalPath) - entryOffset(parsed, b.removalPath));
  }

  function subtreeOf(model, elementId) {
    const ids = new Set();
    const visit = (id) => { ids.add(id); model.elements.get(id).childIds.forEach(visit); };
    visit(elementId);
    return ids;
  }

  /**
   * The references that resolve now and stop resolving once `elementId` sits under `newParentId` (spec §4.10): a
   * collaborator's requested `responsibility` (§4.6), a `uses` entry (J7), and an operation's `realizes` entry naming a
   * responsibility that is no longer its provider's or inside it (J12).
   */
  function moveDependents(design, elementId, newParentId) {
    const { model, parsed } = design;
    const moved = movedModel(model, elementId, newParentId);
    const found = [];
    model.relationships.forEach((relationship) => {
      const { sourceId, targetId } = relationship;
      const responsibility = model.responsibilityById.get(relationship.responsibility);
      if (responsibility && servesRequest(model, responsibility.ownerId, sourceId, targetId) &&
          !servesRequest(moved, responsibility.ownerId, sourceId, targetId)) {
        found.push({ kind: 'responsibility', removalPath: relationship.path.concat('responsibility'),
          label: `${nameOf(model, sourceId)} asks ${nameOf(model, targetId)} for ${relationship.responsibility}` });
      }
      relationship.uses.filter((use) => modelApi.useKind(moved, sourceId, targetId, use.interfaceId) === null).forEach((use) => {
        found.push({ kind: 'uses', removalPath: use.path, label: `${nameOf(model, sourceId)} uses ${use.text} of ${nameOf(model, targetId)}` });
      });
    });
    const data = yamlAdapter.toData(parsed);
    model.interfaces.forEach((declared) => declared.operations.forEach((operation) => {
      eachText(fieldOf(valueAt(data, operation.path), 'realizes'), operation.path.concat('realizes'), (id, path) => {
        const responsibility = model.responsibilityById.get(id);
        if (!responsibility || !isSameOrInside(model, responsibility.ownerId, declared.providerId) ||
            isSameOrInside(moved, responsibility.ownerId, declared.providerId)) return;
        found.push({ kind: 'realizes', removalPath: path, label: `Operation ${operation.id} of ${declared.name} realizes ${id}` });
      });
    }));
    return outermostInOrder(parsed, found);
  }

  /** `model` as it reads once `elementId` sits under `newParentId`, for the containment rules (parents only). */
  function movedModel(model, elementId, newParentId) {
    const elements = new Map([...model.elements].map(([id, element]) =>
      [id, id === elementId ? Object.assign({}, element, { parentId: newParentId }) : element]));
    return Object.assign({}, model, { elements });
  }

  /**
   * Whether a relationship from `sourceId` to `targetId` may ask `ownerId` for help (spec §4.6): the owner is the
   * target, a part of it, or an element that contains the target and is neither the source nor contains it.
   */
  function servesRequest(model, ownerId, sourceId, targetId) {
    if (isSameOrInside(model, ownerId, targetId)) return true;
    return isAncestor(model, ownerId, targetId) && ownerId !== sourceId && !isAncestor(model, ownerId, sourceId);
  }

  function isSameOrInside(model, id, containerId) {
    return id === containerId || isAncestor(model, containerId, id);
  }

  function nameOf(model, id) {
    return model.elements.has(id) ? model.elements.get(id).name : id;
  }

  // ---- Reference sites ------------------------------------------------------------------------
  //
  // A site is one place in the document that names elements, responsibilities, or interfaces: `{ target, ids, kind,
  // path, form, removalPath, label }`. `target` is 'element', 'responsibility', or 'interface' (ids in lowercase, as
  // interface ids are unique ignoring case); `form` says how a rename rewrites the text at `path`: 'key' (a map key),
  // 'value' (a scalar), 'step-key' (the `a -> b` key of a step), 'uses' (a `uses` entry, which also has `operationId`),
  // 'instance' (an instance key `<element>@<node>` of a layout route, whose element is the site's id and whose node is
  // kept as `nodeId`), or 'selector-key' and 'selector-value' (a view selector, kept as `selector`, whose ids are the
  // elements it names; a stored view selector that opens an interface's card also keeps that interface's id in
  // lowercase as `cardInterfaceId`).
  // `removalPath` is the entry a delete removes, or null when the site is never removed (a view selector).

  function referenceSites(design) {
    const data = yamlAdapter.toData(design.parsed);
    const sites = [];
    const nameOf = (id) => (design.model.elements.has(id) ? design.model.elements.get(id).name : id);
    const context = { data, nameOf, add: (site) => sites.push(site) };
    design.model.elements.forEach((element) => elementSites(context, element));
    scenarioSites(context);
    deploymentSites(context);
    decisionSites(context);
    viewSites(context);
    layoutSites(context);
    ignoreSites(context);
    return sites;
  }

  /** A site at `path` naming `ids`; a delete removes the entry at `removalPath`, by default the site itself. */
  function referenceSite(target, kind, ids, path, form, label, removalPath = path) {
    return { target, kind, ids, path, form, label, removalPath };
  }

  /** Calls `visit(id, path)` for a one-or-many field: one text, or the texts of a list. */
  function eachText(value, path, visit) {
    if (typeof value === 'string') visit(value, path);
    else if (Array.isArray(value)) value.forEach((item, index) => typeof item === 'string' && visit(item, path.concat(index)));
  }

  function elementSites(context, element) {
    const { data, nameOf, add } = context;
    const fields = valueAt(data, element.path);
    if (!isMap(fields)) return;
    const collaborators = fields.collaborators;
    if (isMap(collaborators)) {
      Object.entries(collaborators).forEach(([targetId, value]) => {
        const targetPath = element.path.concat('collaborators', targetId);
        add(referenceSite('element', 'collaborator', [targetId], targetPath, 'key', `${element.name} collaborates with ${nameOf(targetId)}`));
        eachCollaboration(value, targetPath, (item, itemPath) => {
          eachText(fieldOf(item, 'uses'), itemPath.concat('uses'), (text, path) =>
            addUsesSite(context, text, path, `${element.name} uses ${text} of ${nameOf(targetId)}`));
          if (typeof fieldOf(item, 'responsibility') !== 'string') return;
          add(referenceSite('responsibility', 'responsibility', [item.responsibility], itemPath.concat('responsibility'), 'value',
            `${element.name} asks ${nameOf(targetId)} for ${item.responsibility}`));
        });
      });
    }
    if (Array.isArray(fields.responsibilities)) {
      fields.responsibilities.forEach((item, index) => {
        eachText(fieldOf(item, 'refines'), element.path.concat('responsibilities', index, 'refines'), (id, path) =>
          add(referenceSite('responsibility', 'refines', [id], path, 'value', `A responsibility of ${element.name} refines ${id}`)));
      });
    }
    realizesSites(context, element, fields.provides);
    if (element.type !== 'code') return;
    ['extends', 'implements'].forEach((kind) => eachText(fields[kind], element.path.concat(kind), (id, path) =>
      add(referenceSite('element', kind, [id], path, 'value', `${element.name} ${kind} ${nameOf(id)}`))));
  }

  /** A `uses` entry naming an interface, or an operation of it; malformed entries name nothing. */
  function addUsesSite(context, text, path, label) {
    const ref = schema.parseUsesRef(text);
    if (ref.error) return;
    context.add(Object.assign(referenceSite('interface', 'uses', [ref.interfaceId.toLowerCase()], path, 'uses', label),
      { operationId: ref.operationId, text: text.trim() }));
  }

  /** The `realizes` entries of the operations of an element's full-form interfaces. */
  function realizesSites(context, element, provides) {
    if (!isMap(provides)) return;
    Object.entries(provides).forEach(([interfaceId, declared]) => {
      const operations = fieldOf(declared, 'operations');
      if (!isMap(operations)) return;
      Object.entries(operations).forEach(([operationId, operation]) => {
        const path = element.path.concat('provides', interfaceId, 'operations', operationId, 'realizes');
        eachText(fieldOf(operation, 'realizes'), path, (id, itemPath) => context.add(referenceSite('responsibility', 'realizes', [id],
          itemPath, 'value', `Operation ${operationId} of ${interfaceId} realizes ${id}`)));
      });
    });
  }

  /** The `uses` sites naming the interface `interfaceId`, or only its operation `operationId`, in document order. */
  function usesSites(design, interfaceId, operationId) {
    const id = interfaceId.toLowerCase();
    const named = referenceSites(design).filter((site) => site.target === 'interface' && site.ids[0] === id &&
      (operationId === null || site.operationId === operationId));
    return outermostInOrder(design.parsed, named);
  }

  function eachCollaboration(value, path, visit) {
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, path.concat(index)));
    else visit(value, path);
  }

  function scenarioSites(context) {
    const scenarios = context.data && context.data.scenarios;
    if (!isMap(scenarios)) return;
    Object.entries(scenarios).forEach(([id, scenario]) => {
      stepSites(context, fieldOf(scenario, 'steps'), ['scenarios', id, 'steps'], `scenario ${id}`);
    });
  }

  function stepSites(context, steps, path, scenarioLabel) {
    if (!Array.isArray(steps)) return;
    steps.forEach((step, index) => {
      if (!isMap(step)) return;
      const stepPath = path.concat(index);
      const keys = Object.keys(step);
      if (keys.length === 1 && schema.FRAGMENTS.includes(keys[0])) {
        fragmentBranches(step[keys[0]], stepPath.concat(keys[0]))
          .forEach(([branch, branchPath]) => stepSites(context, fieldOf(branch, 'steps'), branchPath.concat('steps'), scenarioLabel));
        return;
      }
      const ends = keys.length === 1 ? schema.parseStepShorthand(keys[0]) : null;
      if (ends) {
        context.add(referenceSite('element', 'step', [ends.from, ends.to], stepPath.concat(keys[0]), 'step-key',
          `Step ${keys[0]} in ${scenarioLabel}`, stepPath));
        return;
      }
      ['from', 'to'].filter((key) => typeof step[key] === 'string').forEach((key) => {
        context.add(referenceSite('element', 'step', [step[key]], stepPath.concat(key), 'value',
          `Step ${step.from} -> ${step.to} in ${scenarioLabel}`, stepPath));
      });
      if (typeof step.responsibility === 'string') {
        context.add(referenceSite('responsibility', 'responsibility', [step.responsibility], stepPath.concat('responsibility'), 'value',
          `Step ${step.from} -> ${step.to} in ${scenarioLabel} requests ${step.responsibility}`));
      }
      if (typeof step.uses === 'string') {
        addUsesSite(context, step.uses, stepPath.concat('uses'), `Step ${step.from} -> ${step.to} in ${scenarioLabel} uses ${step.uses}`);
      }
    });
  }

  /** `[branch, path]` pairs: `alt` and `par` hold a list of branches; `opt`, `loop`, and `break` hold one. */
  function fragmentBranches(value, path) {
    return Array.isArray(value) ? value.map((branch, index) => [branch, path.concat(index)]) : [[value, path]];
  }

  function deploymentSites(context) {
    const environments = context.data && context.data.deployment;
    if (!isMap(environments)) return;
    const visitNodes = (nodes, path, environmentId) => {
      if (!isMap(nodes)) return;
      Object.entries(nodes).forEach(([nodeId, node]) => {
        const nodePath = path.concat(nodeId);
        eachText(fieldOf(node, 'hosts'), nodePath.concat('hosts'), (id, hostPath) => context.add(referenceSite('element', 'hosts', [id],
          hostPath, 'value', `Deployment node ${nodeId} in ${environmentId} hosts ${context.nameOf(id)}`)));
        visitNodes(fieldOf(node, 'nodes'), nodePath.concat('nodes'), environmentId);
      });
    };
    Object.entries(environments).forEach(([id, environment]) => visitNodes(fieldOf(environment, 'nodes'), ['deployment', id, 'nodes'], id));
  }

  function decisionSites(context) {
    const decisions = context.data && context.data.decisions;
    if (!isMap(decisions)) return;
    Object.entries(decisions).forEach(([id, decision]) => eachText(fieldOf(decision, 'affects'), ['decisions', id, 'affects'],
      (elementId, path) => context.add(referenceSite('element', 'affects', [elementId], path, 'value', `Decision ${id} affects ${context.nameOf(elementId)}`))));
  }

  function viewSites(context) {
    const { data, add } = context;
    if (!isMap(data)) return;
    const selectorSite = (selector, path, label) => {
      const ids = typeof selector === 'string' ? selectorElementIds(selector) : null;
      if (!ids) return;
      add(Object.assign(referenceSite('element', 'view', ids, path, 'selector-value', label, null),
        { selector, cardInterfaceId: cardInterfaceOf(selector) }));
    };
    selectorSite(data.view, ['view'], 'The initial view');
    if (!isMap(data.views)) return;
    Object.entries(data.views).forEach(([id, view]) => {
      selectorSite(fieldOf(view, 'view'), ['views', id, 'view'], `View ${id}`);
      [['include', 'includes'], ['exclude', 'excludes']].forEach(([kind, verb]) => eachText(fieldOf(view, kind), ['views', id, kind],
        (elementId, path) => add(referenceSite('element', kind, [elementId], path, 'value', `View ${id} ${verb} ${context.nameOf(elementId)}`))));
    });
  }

  /**
   * The element ids a selector names (`containers of shop` → shop, `interface card-payments of payments` → payments,
   * `interface enrollment-api` → none); null when it names neither an element nor an interface, or is malformed.
   */
  function selectorElementIds(selector) {
    const parsed = schema.parseSelector(selector);
    if (parsed.error) return null;
    if (parsed.type === 'interfaces' || hasOwn(schema.ELEMENT_SCOPE_TYPES, parsed.type)) return [parsed.scopeId];
    if (parsed.type !== 'interface') return null;
    return parsed.ofId ? [parsed.ofId] : [];
  }

  /** The id, in lowercase, of the interface whose description card a selector opens; null for any other selector. */
  function cardInterfaceOf(selector) {
    const parsed = schema.parseSelector(selector);
    return !parsed.error && parsed.type === 'interface' ? parsed.interfaceId : null;
  }

  /** `selector` with the element and interface ids it names renamed by `renames`, written as it was otherwise. */
  function renamedSelector(selector, renames) {
    const element = (id) => (renames.element.has(id) ? renames.element.get(id) : id);
    const interfaceId = (id) => renames.interface.get(id.toLowerCase()) || id;
    return schema.withSelectorScope(selector, element, interfaceId);
  }

  function layoutSites(context) {
    const layout = context.data && context.data.layout;
    if (!isMap(layout)) return;
    Object.entries(layout).forEach(([key, value]) => {
      const ids = selectorElementIds(key);
      if (ids) context.add(Object.assign(referenceSite('element', 'layout', ids, ['layout', key], 'selector-key', `Layout of ${key}`), { selector: key }));
      const view = umlLayoutView(context.data, key);
      if (view) umlLayoutSites(context, key, view.type, value);
      else if (isMap(value)) {
        Object.keys(value).forEach((id) => context.add(referenceSite('element', 'layout', [id], ['layout', key, id], 'key',
          `Position of ${context.nameOf(id)} in the layout of ${key}`)));
      }
    });
  }

  /**
   * The element sites of a UML view's layout entry (UML-view editing spec §4.2): its position keys, except in a deployment
   * view, whose positions are keyed by node; the ends of its routes, which are elements in a code view, and of which the
   * element part of an instance key `<element>@<node>` is one on a derived path; and its lifelines. A delete removes the
   * position, the whole route, or the lifeline.
   */
  function umlLayoutSites(context, key, type, value) {
    const { add, nameOf } = context;
    const path = ['layout', key];
    const positions = fieldOf(value, 'positions');
    if (type !== 'deployment' && isMap(positions)) {
      Object.keys(positions).forEach((id) => add(referenceSite('element', 'layout', [id], path.concat('positions', id), 'key',
        `Position of ${nameOf(id)} in the layout of ${key}`)));
    }
    const routes = fieldOf(value, 'routes');
    if (Array.isArray(routes)) routes.forEach((route, index) => routeSites(context, key, type, route, path.concat('routes', index)));
    const lifelines = fieldOf(value, 'lifelines');
    if (!Array.isArray(lifelines)) return;
    lifelines.forEach((id, index) => {
      if (typeof id === 'string') add(referenceSite('element', 'layout', [id], path.concat('lifelines', index), 'value', `Place of ${nameOf(id)} in the lifeline order of ${key}`));
    });
  }

  function routeSites(context, key, type, route, routePath) {
    if (!isMap(route) || typeof route.from !== 'string' || typeof route.to !== 'string') return;
    const endName = (end) => {
      const instance = instanceKeyParts(end);
      return instance ? `${context.nameOf(instance.elementId)} on ${instance.nodeId}` : context.nameOf(end);
    };
    const label = `Route of the line from ${endName(route.from)} to ${endName(route.to)} in the layout of ${key}`;
    ['from', 'to'].forEach((end) => {
      if (type === 'code') {
        context.add(referenceSite('element', 'layout', [route[end]], routePath.concat(end), 'value', label, routePath));
        return;
      }
      const instance = route.relation === 'derived' ? instanceKeyParts(route[end]) : null;
      if (instance) {
        context.add(Object.assign(referenceSite('element', 'layout', [instance.elementId], routePath.concat(end), 'instance', label, routePath),
          { nodeId: instance.nodeId }));
      }
    });
  }

  function ignoreSites(context) {
    const ignore = fieldOf(context.data && context.data.checks, 'ignore');
    if (!Array.isArray(ignore)) return;
    ignore.forEach((entry, index) => {
      if (typeof fieldOf(entry, 'element') !== 'string') return;
      const path = ['checks', 'ignore', index];
      context.add(referenceSite('element', 'ignore', [entry.element], path.concat('element'), 'value',
        `Ignored check ${entry.rule} on ${context.nameOf(entry.element)}`, path));
    });
  }

  // ---- Layout entries of UML-notation views (UML-view editing spec §4.2) ----------------------

  /** `{ elementId, nodeId }` of an instance key `<element>@<node>`, or null for text of another form. */
  function instanceKeyParts(text) {
    const match = /^([^@]+)@([^@]+)$/.exec(String(text));
    return match ? { elementId: match[1], nodeId: match[2] } : null;
  }

  /** The view `{ type, scopeId }` of a layout key when it is drawn in UML notation, or null; custom views come from `data`. */
  function umlLayoutView(data, key) {
    const customSelector = (viewId) => {
      const selector = fieldOf(fieldOf(fieldOf(data, 'views'), viewId), 'view');
      return typeof selector === 'string' ? selector : null;
    };
    const view = schema.layoutView(key, customSelector);
    return view && hasOwn(schema.UML_LAYOUT_PARTS, view.type) ? view : null;
  }

  /**
   * The layout paths a removal in the environment `environmentId` takes away from the entries of its deployment views:
   * the positions of `nodeIds`, and every route with an end at one of those nodes, at an instance key in `instanceKeys`,
   * or at an instance hosted on one of those nodes.
   */
  function deploymentLayoutPaths(data, environmentId, { nodeIds = new Set(), instanceKeys = new Set() }) {
    const endGoes = (end) => {
      const instance = instanceKeyParts(end);
      return nodeIds.has(end) || instanceKeys.has(end) || Boolean(instance && nodeIds.has(instance.nodeId));
    };
    return deploymentPositionPaths(data, environmentId, nodeIds)
      .concat(deploymentRoutePaths(data, environmentId, (route) => endGoes(route.from) || endGoes(route.to)));
  }

  /** The layout paths of the positions of `nodeIds` in the entries of the deployment views of `environmentId`. */
  function deploymentPositionPaths(data, environmentId, nodeIds) {
    return deploymentLayoutEntries(data, environmentId).flatMap(([key, value]) => {
      const positions = fieldOf(value, 'positions');
      return isMap(positions) ? Object.keys(positions).filter((id) => nodeIds.has(id)).map((id) => ['layout', key, 'positions', id]) : [];
    });
  }

  /** The layout path of the stored route of the link from `nodeId` to `targetNodeId`, in each deployment view of the environment. */
  function linkRoutePaths(data, environmentId, nodeId, targetNodeId) {
    return deploymentRoutePaths(data, environmentId, (route) => route.relation === 'link' && route.from === nodeId && route.to === targetNodeId);
  }

  /** The layout paths of the routes, written as maps, that `matches` in the entries of the deployment views of the environment. */
  function deploymentRoutePaths(data, environmentId, matches) {
    return deploymentLayoutEntries(data, environmentId).flatMap(([key, value]) => {
      const routes = fieldOf(value, 'routes');
      if (!Array.isArray(routes)) return [];
      return routes.flatMap((route, index) => (isMap(route) && matches(route) ? [['layout', key, 'routes', index]] : []));
    });
  }

  /** `[key, entry]` of each layout entry of a deployment view of `environmentId`, custom views included. */
  function deploymentLayoutEntries(data, environmentId) {
    const layout = fieldOf(data, 'layout');
    if (!isMap(layout)) return [];
    return Object.entries(layout).filter(([key]) => {
      const view = umlLayoutView(data, key);
      return Boolean(view) && view.type === 'deployment' && view.scopeId === environmentId;
    });
  }

  /**
   * The edits that give the node `nodeId` of `environmentId` the id `newId` in the entries of the environment's
   * deployment views (UML-view editing spec §4.2): its `positions` key, a `link` route's end, and the node part of an
   * instance key `<element>@<node>` at a `derived` route's end.
   */
  function nodeLayoutRenameEdits(parsed, environmentId, nodeId, newId) {
    return deploymentLayoutEntries(yamlAdapter.toData(parsed), environmentId).flatMap(([key, value]) => {
      const path = ['layout', key];
      const positions = fieldOf(value, 'positions');
      const routes = fieldOf(value, 'routes');
      const edits = isMap(positions) && hasOwn(positions, nodeId) ? yamlAdapter.renameKey(parsed, path.concat('positions'), nodeId, newId) : [];
      (Array.isArray(routes) ? routes : []).forEach((route, index) => ['from', 'to'].forEach((end) => {
        const renamed = renamedRouteEnd(route, end, nodeId, newId);
        if (renamed !== null) edits.push(...yamlAdapter.replaceValue(parsed, path.concat('routes', index, end), renamed));
      }));
      return edits;
    });
  }

  /** A deployment route's end with the node `nodeId` renamed, or null when that end does not name the node. */
  function renamedRouteEnd(route, end, nodeId, newId) {
    if (!isMap(route) || typeof route[end] !== 'string') return null;
    if (route.relation === 'link') return route[end] === nodeId ? newId : null;
    const instance = route.relation === 'derived' ? instanceKeyParts(route[end]) : null;
    return instance && instance.nodeId === nodeId ? `${instance.elementId}@${newId}` : null;
  }

  /**
   * `paths` in which the entries of a UML view's layout part (`positions`, `routes`, `lifelines`) that they all name
   * give way to the part, and the parts of an entry that this empties give way to the entry, so that a removal leaves
   * no empty part or entry behind (UML-view editing spec §4.2). The splice kit's pruning then removes a `layout`
   * section that empties in turn.
   */
  function withEmptiedLayoutParts(data, paths) {
    const layout = fieldOf(data, 'layout');
    const inPart = (path) => path.length === 4 && path[0] === 'layout' && schema.LAYOUT_PART_ORDER.includes(path[2]) &&
      Boolean(umlLayoutView(data, path[1]));
    if (!isMap(layout) || !paths.some(inPart)) return paths;
    const count = (value) => (Array.isArray(value) ? value.length : isMap(value) ? Object.keys(value).length : 0);
    const byPart = new Map();
    paths.filter(inPart).forEach((path) => {
      const part = JSON.stringify(path.slice(0, 3));
      byPart.set(part, (byPart.get(part) || new Set()).add(JSON.stringify(path)));
    });
    const emptied = [...byPart].filter(([part, entries]) => entries.size === count(valueAt(data, JSON.parse(part))))
      .map(([part]) => JSON.parse(part));
    // An entry empties when each of its keys is a part that goes or a part that is empty already.
    const isEmptiedEntry = (key) => {
      const goes = new Set(emptied.filter((part) => part[1] === key).map((part) => part[2]));
      return goes.size > 0 && Object.entries(layout[key]).every(([part, value]) => goes.has(part)
        || (schema.LAYOUT_PART_ORDER.includes(part) && count(value) === 0));
    };
    const kept = paths.filter((path) => !inPart(path) || !emptied.some((part) => startsWith(path, part)));
    const partPaths = emptied.filter((part) => !isEmptiedEntry(part[1]));
    const entryPaths = [...new Set(emptied.map((part) => part[1]))].filter(isEmptiedEntry).map((key) => ['layout', key]);
    return kept.concat(partPaths, entryPaths);
  }

  // ---- Renaming sites ------------------------------------------------------------------------

  /**
   * Rename tables with every kind present: `element` and `responsibility` map old ids to new ones, `interface` maps
   * lowercase interface ids to new ids, and `operation` maps `<interface id in lowercase>.<operation id>` to new
   * operation ids.
   */
  function renameTables(tables) {
    return Object.assign({ element: new Map(), responsibility: new Map(), interface: new Map(), operation: new Map() }, tables);
  }

  /** The edits that rewrite every reference site for `renames` (see renameTables). */
  function renameEdits(design, renames) {
    return referenceSites(design).flatMap((reference) => renamedSite(design.parsed, reference, renames));
  }

  /** The edits that rewrite `reference` for `renames` (see renameTables). */
  function renamedSite(parsed, reference, renames) {
    if (reference.form === 'uses') return renamedUse(parsed, reference, renames);
    if (reference.form === 'selector-key' || reference.form === 'selector-value') return renamedSelectorSite(parsed, reference, renames);
    const table = renames[reference.target];
    const renamed = (id) => (table.has(id) ? table.get(id) : id);
    if (!reference.ids.some((id) => table.has(id))) return [];
    const { path } = reference;
    const last = path[path.length - 1];
    if (reference.form === 'key') return yamlAdapter.renameKey(parsed, path.slice(0, -1), last, renamed(last));
    if (reference.form === 'value') return yamlAdapter.replaceValue(parsed, path, renamed(reference.ids[0]));
    if (reference.form === 'instance') return yamlAdapter.replaceValue(parsed, path, `${renamed(reference.ids[0])}@${reference.nodeId}`);
    return yamlAdapter.renameKey(parsed, path.slice(0, -1), last, renamedStepKey(last, renamed));
  }

  function renamedSelectorSite(parsed, reference, renames) {
    const rewritten = renamedSelector(reference.selector, renames);
    if (rewritten === reference.selector) return [];
    const { path } = reference;
    if (reference.form === 'selector-key') return yamlAdapter.renameKey(parsed, path.slice(0, -1), path[path.length - 1], rewritten);
    return yamlAdapter.replaceValue(parsed, path, rewritten);
  }

  /** A `uses` entry with its interface and operation renamed; an id that is not renamed keeps how it is written. */
  function renamedUse(parsed, reference, renames) {
    const [interfaceKey] = reference.ids;
    const [written] = reference.text.split('.');
    const interfaceId = renames.interface.get(interfaceKey) || written;
    if (reference.operationId === null) return interfaceId === written ? [] : yamlAdapter.replaceValue(parsed, reference.path, interfaceId);
    const operationId = renames.operation.get(`${interfaceKey}.${reference.operationId}`) || reference.operationId;
    const text = `${interfaceId}.${operationId}`;
    return text === reference.text ? [] : yamlAdapter.replaceValue(parsed, reference.path, text);
  }

  /** `a -> b` with each end renamed, keeping the spacing around the arrow. */
  function renamedStepKey(key, renamed) {
    return key.split('->').map((end) => end.replace(/\S+/, (id) => renamed(id))).join('->');
  }

  return {
    isAncestor, findInterface, shorthandInterfaceOf, interfaceIdTaken, dependentsOf, interfaceDependentsOf, interfaceSelectorsOf,
    dependents, moveDependents, referenceSites, usesSites, renameTables, renameEdits, umlLayoutView, instanceKeyParts,
    deploymentLayoutPaths, deploymentPositionPaths, linkRoutePaths, nodeLayoutRenameEdits, withEmptiedLayoutParts,
  };
});
