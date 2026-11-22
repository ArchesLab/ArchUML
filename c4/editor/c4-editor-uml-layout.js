(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.umlLayout = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The layout planner of the C4 editor's UML-notation views (UML-view editing spec §6; plan Task 36): what a move, a
  // drop, a return to automatic layout, and Reset layout write. It is DOM-free: it reads the view's context (the design,
  // the view model with its stored layout, the drawn `toUml` result, and the routes the drawing dropped) and the scene
  // facts an operation carries, and answers with a plan for the C4 model adapter to run. Every plan writes through one
  // `setUmlLayout`, whose merge rules (C4 core, plan Task 28) keep what a plan leaves out:
  //
  // 1. The first move in a view pins every box that can hold a position (the view module's `holders`) where it is
  //    drawn, so nothing jumps afterwards. A tile dropped at a point in a view without positions is that first move.
  // 2. A later move writes the moved boxes and the bends the move shifted, nothing else.
  // 3. A stored bend the last drawing dropped (`renderDelegatedView`, §6 rule 5) is removed at the next layout write,
  //    and the plan's message says so.
  // 4. A box or line that holds no layout is refused with the view module's `layoutRefusal`; a bend where two lines of
  //    one kind join one pair in one direction is refused here (`layout/parallel-lines`), because a stored route is
  //    keyed by its ends and its kind (§4.2).
  //
  // A box is named by its alias in the drawing (its layout id) and written under the model id the drawing's `ids` give
  // it; a line is named by its route id `rel:<line>`, whose source-map entry gives its stored key. A point is
  // `{ x, y }` (as the diagram editor's scene gives it) or `[x, y]`; the planner writes whole numbers.

  const ROUTE_ID = /^rel:(\d+)$/;
  // The gap the UML editor leaves right of the drawn boxes for an element added without a drop point
  // (`addElementWithoutCanvas` in _includes/uml-editor.html), and the top it places it at.
  const FREE_PLACE = { gap: 60, minimumEdge: 60, y: 80 };

  /**
   * The plan of a move. `move`: `positions` (`{ <alias>: point }`, the moved boxes at their new places), `routes`
   * (`[{ id, points }]`, the bends the gesture changed), `added` (`{ <model id>: point }`, a box being added at a drop
   * point, which the drawing does not show yet), and `facts` (`positions`: every drawn box's place by alias;
   * `shiftedRoutes`: `{ <route id>: { points } }`, the stored bends the move shifted), all in drawing points;
   * `context.frame` turns a box's place into the layout's (see inLayoutFrame). `module` is the view module,
   * whose `holders(context)` and `layoutRefusal(ref, context)` say which boxes and lines hold layout. Returns a
   * `commands` plan with one `setUmlLayout`, or a `refuse` plan.
   */
  function planMove(move, context, module) {
    const holders = module.holders(context);
    const positions = move.positions || {};
    const routes = move.routes || [];
    const facts = move.facts || {};
    const refusal = boxRefusal(Object.keys(positions), holders, context, module)
      || routes.map((route) => routeRefusal(route.id, context, module)).find(Boolean);
    if (refusal) return refusal;

    const written = {};
    const firstMove = storedPositionCount(context) === 0;
    // The scene gives drawing points. A box's kept place is in the layout's own frame, which the drawing may show
    // shifted (inLayoutFrame); a bend's points are drawn as kept, so they are written as the scene gives them.
    const kept = (place) => point(inLayoutFrame(place, context.frame));
    if (firstMove) {
      holders.forEach((alias) => {
        const drawn = (facts.positions || {})[alias];
        if (drawn) written[idOf(alias, context)] = kept(drawn);
      });
    }
    Object.entries(positions).forEach(([alias, place]) => { written[idOf(alias, context)] = kept(place); });
    Object.entries(move.added || {}).forEach(([id, place]) => { written[id] = kept(place); });

    const changedRoutes = Object.entries(facts.shiftedRoutes || {}).map(([routeId, route]) => ({ routeId, points: route.points }))
      .concat(routes.map((route) => ({ routeId: route.id, points: route.points })))
      .map((route) => Object.assign(routeKey(route.routeId, context), { points: route.points.map(point) }));
    const movedNames = Object.keys(positions).map((alias) => displayName(idOf(alias, context), context))
      .concat(Object.keys(move.added || {}).map((id) => displayName(id, context)));
    const words = movedNames.length > 0
      ? { label: `Move ${listed(movedNames)}`, message: `Moved ${listed(movedNames)}${placeOfOne(positions, move.added, written, context)}.` }
      : { label: 'Move a bend', message: `Moved the bend of ${linePhrase(changedRoutes[0], context)}.` };
    if (firstMove && Object.keys(written).length > movedNames.length) {
      words.message += ' The other boxes of this view now keep their places.';
    }
    return layoutPlan(context, { positions: written, routes: changedRoutes }, words, selectionOf(Object.keys(positions)[0], context));
  }

  /**
   * The plan of a reset: `target` is 'all' (Reset layout: the view's whole entry goes), `{ element: <alias> }` (return
   * to automatic layout: that box's position goes), or `{ route: <route id> }` (that line's stored bend goes).
   */
  function planReset(target, context) {
    if (target === 'all') return resetAll(context);
    if (target && target.route) {
      const route = Object.assign(routeKey(target.route, context), { points: null });
      const line = linePhrase(route, context);
      return layoutPlan(context, { routes: [route] }, { label: 'Remove a bend', message: `${line.charAt(0).toUpperCase()}${line.slice(1)} is routed for you again.` });
    }
    const id = idOf(target.element, context);
    const name = displayName(id, context);
    return layoutPlan(context, { positions: { [id]: null } },
      { label: `Place ${name} automatically`, message: `${name} is placed automatically again.` }, selectionOf(target.element, context));
  }

  /**
   * The free place for a box added without a drop point in a view that holds positions (spec §6 rule 2): right of the
   * drawn boxes, as the UML editor places it. `context.boxes` are the drawn boxes' rectangles (`{ x, y, width,
   * height }` by alias, in drawing units).
   */
  function freePlace(context) {
    const right = Object.values(context.boxes || {}).reduce((edge, box) => Math.max(edge, box.x + box.width), FREE_PLACE.minimumEdge);
    return { x: right + FREE_PLACE.gap, y: FREE_PLACE.y };
  }

  /**
   * The sentence that says the stored bends `dropped` (`[{ from, to, relation }]`, as `renderDelegatedView` lists
   * them) were removed, or '' when there are none.
   */
  function droppedRoutesSentence(dropped, context) {
    if (!dropped || dropped.length === 0) return '';
    const lines = dropped.map((route) => linePhrase(route, context));
    return dropped.length === 1
      ? `The stored bend of ${lines[0]} no longer met its boxes, so it is removed.`
      : `The stored bends of ${listed(lines)} no longer met their boxes, so they are removed.`;
  }

  /**
   * The name a sentence gives the thing a layout entry keys by `id`: an element's name, a deployment node's name in the
   * view's environment, or for an instance key `<element>@<node>` "‹element› on ‹node›"; the id itself otherwise.
   */
  function displayName(id, context) {
    const model = context.design.model;
    const element = model.elements.get(id);
    if (element) return element.name || id;
    const environment = context.viewModel.type === 'deployment' ? model.environments.get(context.viewModel.scopeId) : null;
    const node = environment ? environment.nodes.get(id) : null;
    if (node) return node.name || id;
    const at = id.indexOf('@');
    if (environment && at > 0) return `${displayName(id.slice(0, at), context)} on ${displayName(id.slice(at + 1), context)}`;
    return id;
  }

  // ---- Plans ---------------------------------------------------------------------------------

  /**
   * A `commands` plan of one `setUmlLayout` for the view of `context`, with `parts` (`positions`, `routes`), the
   * removal of the routes the drawing dropped, and the sentence that says so after `words.message`.
   */
  function layoutPlan(context, parts, words, select = null) {
    const routes = (parts.routes || []).concat(droppedRemovals(context, parts.routes || []));
    const command = { op: 'setUmlLayout', viewKey: context.viewModel.key };
    if (parts.positions && Object.keys(parts.positions).length > 0) command.positions = parts.positions;
    if (routes.length > 0) command.routes = routes;
    const dropped = droppedRoutesSentence(context.droppedRoutes, context);
    return {
      kind: 'commands', commands: [command], label: words.label, select,
      message: dropped ? `${words.message} ${dropped}` : words.message, confirm: null,
    };
  }

  /** Reset layout: every part the view's entry holds is removed, so the core prunes the entry. */
  function resetAll(context) {
    const stored = context.layout;
    const command = { op: 'setUmlLayout', viewKey: context.viewModel.key };
    if (stored && stored.positions.size > 0) command.positions = null;
    if (stored && stored.routes.length > 0) command.routes = null;
    if (stored && stored.lifelines.length > 0) command.lifelines = null;
    return {
      kind: 'commands', commands: Object.keys(command).length > 2 ? [command] : [], label: 'Reset layout', select: null,
      message: 'The layout of this view is automatic again.', confirm: null,
    };
  }

  /** Removals (`points: null`) of the routes the drawing dropped that `written` does not write again. */
  function droppedRemovals(context, written) {
    return (context.droppedRoutes || []).filter((route) => !written.some((other) => sameKey(other, route)))
      .map((route) => ({ from: route.from, to: route.to, relation: route.relation, points: null }));
  }

  // ---- Refusals ------------------------------------------------------------------------------

  /** The refusal of the first moved box that holds no position (with the module's `layoutRefusal`), or null. */
  function boxRefusal(aliases, holders, context, module) {
    const alias = aliases.find((candidate) => !holders.has(candidate));
    return alias === undefined ? null : moduleRefusal(alias, context, module);
  }

  /**
   * The refusal of a bend on the line of `routeId`: the module's `layoutRefusal` (an inheritance line, a ball and its
   * socket), else `layout/parallel-lines` when the drawing has another line of the same kind from the same box to the
   * same box; null when the line can hold the bend.
   */
  function routeRefusal(routeId, context, module) {
    const refused = moduleRefusal(routeId, context, module);
    if (refused) return refused;
    const key = routeKey(routeId, context);
    const parallel = context.uml.source.lines.filter((entry) => entry && isRouteLine(entry) && sameKey(keyOfLine(entry), key)).length > 1;
    return parallel ? refuse('layout/parallel-lines', { A: displayName(key.from, context), B: displayName(key.to, context) }) : null;
  }

  function moduleRefusal(ref, context, module) {
    const refused = module.layoutRefusal(ref, context);
    return refused ? refuse(refused.code, refused.values || {}) : null;
  }

  function refuse(code, values) {
    return { kind: 'refuse', code, values, offer: null };
  }

  // ---- Reading the drawing -------------------------------------------------------------------

  /** The model id of the drawn box `alias`: what the drawing's `ids` map it to. */
  function idOf(alias, context) {
    if (!Object.prototype.hasOwnProperty.call(context.uml.ids, alias)) throw new TypeError(`The drawing has no box ${JSON.stringify(alias)}`);
    return context.uml.ids[alias];
  }

  /** The stored key (`{ from, to, relation }`) of the line whose route id is `routeId`. */
  function routeKey(routeId, context) {
    const match = ROUTE_ID.exec(routeId);
    const entry = match ? context.uml.source.lines[Number(match[1])] : null;
    if (!entry || !isRouteLine(entry)) throw new TypeError(`The drawing has no line that keeps a bend under ${JSON.stringify(routeId)}`);
    return keyOfLine(entry);
  }

  /** Whether a source-map entry is a line a stored route can name: a code view's line or a deployment link. */
  function isRouteLine(entry) {
    return entry.kind === 'relation' || entry.kind === 'link';
  }

  /** The stored key of a line's source-map entry, as `renderDelegatedView` names a dropped route. */
  function keyOfLine(entry) {
    const relation = entry.kind === 'link' ? (entry.derived ? 'derived' : 'link') : entry.relation;
    return { from: entry.from, to: entry.to, relation };
  }

  function sameKey(a, b) {
    return a.from === b.from && a.to === b.to && a.relation === b.relation;
  }

  function storedPositionCount(context) {
    return context.layout ? context.layout.positions.size : 0;
  }

  /** The selection of the box `alias` after the move, `{ elementId }` or `{ environmentId, nodeId }`; or null. */
  function selectionOf(alias, context) {
    if (alias === undefined) return null;
    const id = idOf(alias, context);
    if (context.design.model.elements.has(id)) return { elementId: id };
    return context.viewModel.type === 'deployment' ? { environmentId: context.viewModel.scopeId, nodeId: id } : null;
  }

  // ---- Words ---------------------------------------------------------------------------------

  /**
   * " to ‹x›, ‹y›" when one box moves: the place it is kept at (`written`, by model id), as the C4 views' moves name it
   * (spec §7.4: each result is announced with its place); '' when several boxes move or a box is being added.
   */
  function placeOfOne(positions, added, written, context) {
    const moved = Object.keys(positions);
    if (moved.length !== 1 || Object.keys(added || {}).length > 0) return '';
    const [x, y] = written[idOf(moved[0], context)];
    return ` to ${x}, ${y}`;
  }

  /** A place in whole drawing units; a place a hair below 0 is 0, never -0, which design.yml would write as "-0". */
  function point(place) {
    const [x, y] = Array.isArray(place) ? place : [place.x, place.y];
    return [Math.round(x) + 0, Math.round(y) + 0];
  }

  /**
   * A drawing point in the layout's frame. `frame` (`{ x, y }`, from the drawing) is where the layout's origin lies in
   * the drawing: the renderer fits a pinned drawing to its margins and its header, so a box kept at (x, y) is drawn at
   * (x + frame.x, y + frame.y). Without a frame (no kept position in the drawing) the two are taken as one.
   */
  function inLayoutFrame(place, frame) {
    const [x, y] = Array.isArray(place) ? place : [place.x, place.y];
    return frame ? [x - frame.x, y - frame.y] : [x, y];
  }

  function linePhrase(route, context) {
    return `the line from ${displayName(route.from, context)} to ${displayName(route.to, context)}`;
  }

  function listed(names) {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  return { planMove, planReset, freePlace, droppedRoutesSentence, displayName, inLayoutFrame };
});
