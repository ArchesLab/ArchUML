(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return {
        C4: require('../c4-core.js'),
        shared: require('./c4-editor-actions-shared.js'),
        layout: require('./c4-editor-uml-layout.js'),
        refusals: require('./c4-editor-uml-refusals.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    var view = factory(function () {
      return { C4: root.ArchUMLC4, shared: parts.actionsShared, layout: parts.umlLayout, refusals: parts.umlRefusals };
    });
    parts.umlViews = parts.umlViews || {};
    parts.umlViews[view.notation] = view;
  }
})(typeof self !== 'undefined' ? self : this, function (siblings) {
  'use strict';

  // The view module of deployment views, `deployment ‹environment›`, drawn as UML deployment diagrams (UML-view editing
  // spec §5.4, §7.3; plan Task 43). It tells the canvas what a deployment view offers (option sets, tools, which boxes
  // hold a position, the items of a box's menu) and plans what each operation of the diagram editor means in
  // design.yml. It decides nothing the C4 core decides: the C4 model adapter (c4-editor-uml-adapter.js) runs a plan's
  // commands as one batch after a dry run and the lock check, calls the shared action a plan names, opens the form a
  // plan names (`choose`, the editor's menu; `link`, this editor's link form), and words every refusal by the refusal
  // table. Siblings are read at call time, so this file loads in any order.
  //
  // Every member takes the canvas's `context` (plan Task 34). A box is named by its alias in the drawing; `uml.ids` maps
  // it to a node id or to an instance key `‹element›@‹node›`, and the source map (spec §4.1) says which of the two it
  // is and where it is drawn. A line is named by `rel:<n>`, the line of the drawn text (without its layout block) whose
  // source-map entry is a link: declared between two nodes, or derived from relationships between hosted instances.
  //
  // In a design model nesting is data, so putting a node into another node, or a hosted instance on another node, is
  // a real edit here. It is never a side effect of a move (spec §5.4): a move changes a position and nothing else, only
  // top-level nodes hold one, and nesting changes by a drop on a node marked possible (`element.reparent`) or by the
  // menu "Move to…".

  const NOTATION = 'uml-deployment';

  // The palette (spec §5.4, §7.6): the Host tile stands where the UML editor's Component tool stood.
  const ELEMENT_TOOLS = [
    { id: 'node', label: 'Node', glyph: '▣', kind: null },
    { id: 'infrastructure', label: 'Infrastructure node', glyph: '▥', kind: 'infrastructure' },
    { id: 'host', label: 'Host a container or system', glyph: '⊡' },
  ];
  // Two kinds of line, told apart by their ends: a link joins two nodes, a relationship two hosted elements.
  const RELATION_TOOLS = [
    { id: 'link', label: 'Link between nodes', glyph: '─' },
    { id: 'relationship', label: 'Relationship between hosted elements', glyph: '··→' },
  ];
  const UNAVAILABLE_TOOLS = [
    { id: 'component', label: 'Component', code: 'not-in-model/artifact', values: {} },
    { id: 'artifact', label: 'Artifact', code: 'not-in-model/artifact', values: {} },
    { id: 'note', label: 'Note', code: 'not-in-model/note', values: {} },
  ];
  const NODE_TOOLS = new Set(['node', 'infrastructure']);
  const NOT_HOSTABLE_TOOLS = new Set(['component', 'artifact']);
  const NODE_KIND_WORDS = { device: 'device', environment: 'execution environment', infrastructure: 'infrastructure node' };
  // The kinds a node's menu offers (the inspector's node form has the same three).
  const NODE_KINDS = [
    { value: 'device', label: 'Device', phrase: 'a device' },
    { value: 'environment', label: 'Execution environment', phrase: 'an execution environment' },
    { value: 'infrastructure', label: 'Infrastructure', phrase: 'an infrastructure node' },
  ];
  const TYPE_WORDS = { system: 'software system', container: 'container' };
  const HOSTABLE_TYPES = ['system', 'container'];
  const LINE_REF = /^rel:(\d+)$/;
  const OPEN_ENDS = ['from', 'to'];
  // A drop puts a new box's top-left corner this far above and left of the pointer, in drawing units (as the C4
  // surface does, c4-editor-uml-interaction.js `DROP_GRIP_UNITS`), so the pointer is that far below and right of it.
  const DROP_GRIP_UNITS = 12;
  // How far a dropped box may lie from where it is drawn and still count as not moved (the renderer rounds).
  const SAME_PLACE_UNITS = 0.5;
  // The words of the shared actions' refusals of a relationship's ends, by code (c4-editor-actions-shared.js
  // `endsProblem` owns the sentences), for menus, choosers, and C mode (one line, at most 60 characters).
  const END_SUMMARIES = {
    'unknown-element': 'Not in this design model',
    'self-loop': 'Cannot point at itself',
    containment: 'One contains the other',
  };
  // Refusals the table has no row for, each with its own words.
  const ONE_AT_A_TIME = { code: 'one-at-a-time', summary: 'Delete one thing at a time',
    message: 'Select one node, hosted element, or link and delete it; this view deletes one thing at a time.' };
  const RELATIONSHIP_ENDS = { code: 'relationship-ends', summary: 'A relationship joins two hosted elements',
    message: 'A relationship joins two elements that run on nodes. Between two nodes, draw a link.' };

  // ---- Reading the drawing --------------------------------------------------------------------------------

  function model(context) {
    return context.design.model;
  }

  function environment(context) {
    return model(context).environments.get(context.viewModel.scopeId);
  }

  function environmentId(context) {
    return context.viewModel.scopeId;
  }

  function nodeAt(context, nodeId) {
    return environment(context).nodes.get(nodeId);
  }

  function nodeName(context, nodeId) {
    const node = nodeAt(context, nodeId);
    return node ? node.name || nodeId : nodeId;
  }

  function elementName(context, id) {
    return siblings().shared.elementName(model(context), id);
  }

  /**
   * The drawn boxes, in drawing order: `{ alias, kind: 'node', nodeId, parentId }` for a node (its parent a node id, or
   * null at the top level), `{ alias, kind: 'instance', elementId, nodeId }` for a hosted instance.
   */
  function drawnBoxes(context) {
    const aliasOf = aliasesById(context);
    return context.uml.source.lines.filter((entry) => entry && (entry.kind === 'node' || entry.kind === 'instance')).map((entry) => (entry.kind === 'node'
      ? { alias: aliasOf.get(entry.id), kind: 'node', nodeId: entry.id, parentId: entry.parentId || null }
      : { alias: aliasOf.get(`${entry.elementId}@${entry.nodeId}`), kind: 'instance', elementId: entry.elementId, nodeId: entry.nodeId }))
      .filter((box) => box.alias !== undefined);
  }

  function aliasesById(context) {
    return new Map(Object.entries(context.uml.ids).map(([alias, id]) => [id, alias]));
  }

  /** The drawn box `alias`; a TypeError when the drawing has no such box. */
  function boxOf(alias, context) {
    const box = drawnBoxes(context).find((candidate) => candidate.alias === alias);
    if (!box) throw new TypeError(`The deployment view draws no box ${JSON.stringify(alias)}`);
    return box;
  }

  function nodeAliasOf(nodeId, context) {
    const box = drawnBoxes(context).find((candidate) => candidate.kind === 'node' && candidate.nodeId === nodeId);
    return box ? box.alias : null;
  }

  /** The name a sentence gives a box: a node's name, or a hosted element's. */
  function boxName(box, context) {
    return box.kind === 'node' ? nodeName(context, box.nodeId) : elementName(context, box.elementId);
  }

  /** The node a drop on box `alias` lands on: the node itself, or the node a hosted instance runs on. */
  function landingNodeOf(alias, context) {
    const box = boxOf(alias, context);
    return box.nodeId;
  }

  /** Whether node `nodeId` lies inside node `ancestorId`, at any depth. */
  function isInside(context, nodeId, ancestorId) {
    for (let current = nodeAt(context, nodeId).parentId; current; current = nodeAt(context, current).parentId) {
      if (current === ancestorId) return true;
    }
    return false;
  }

  /** The drawn links, `{ index, ref, from, to, derived, relationshipIds }` (ends are node ids or instance keys). */
  function drawnLinks(context) {
    return context.uml.source.lines.map((entry, index) => (entry && entry.kind === 'link'
      ? Object.assign({ index, ref: `rel:${index}` }, entry) : null)).filter(Boolean);
  }

  /** The drawn line a reference names (a `rel:<n>` ref, or an operation's `{ line, candidates }`); a TypeError otherwise. */
  function linkOf(ref, context) {
    const index = lineIndex(ref);
    const link = drawnLinks(context).find((candidate) => candidate.index === index);
    if (!link) throw new TypeError(`Line ${index} of the deployment view is no link`);
    return link;
  }

  function lineIndex(ref) {
    if (typeof ref === 'string' && LINE_REF.test(ref)) return Number(LINE_REF.exec(ref)[1]);
    if (ref && Number.isInteger(ref.line) && ref.line >= 0) return ref.line;
    if (ref && Array.isArray(ref.candidates) && ref.candidates.length === 1) return lineIndex(ref.candidates[0]);
    if (Number.isInteger(ref) && ref >= 0) return ref;
    throw new TypeError('A deployment view acts on one line at a time');
  }

  /** The declared link from node `fromId` to node `toId` (`{ targetId, description, technology }`), or null. */
  function declaredLink(context, fromId, toId) {
    const node = nodeAt(context, fromId);
    return (node && node.relationships.find((link) => link.targetId === toId)) || null;
  }

  /** The first relationship a derived link is drawn from. */
  function derivedSource(link, context) {
    return model(context).relationships.find((relationship) => relationship.id === link.relationshipIds[0]) || null;
  }

  /** A link's end (a node id or an instance key) as a sentence names it. */
  function endName(end, context) {
    const at = end.indexOf('@');
    if (at < 0) return nodeName(context, end);
    const elementId = end.slice(0, at);
    const name = elementName(context, elementId);
    const copies = drawnBoxes(context).filter((box) => box.kind === 'instance' && box.elementId === elementId).length;
    return copies > 1 ? `${name} on ${nodeName(context, end.slice(at + 1))}` : name;
  }

  // ---- Refusals and plans ---------------------------------------------------------------------------------

  function refuse(code, values = {}, offer = null) {
    return { kind: 'refuse', code, values, offer };
  }

  /**
   * Refusal `code` with the table's offer made runnable by `runnable` (spec §5.4): `{ select }`, what the canvas shows
   * in the inspector, or `{ operation }`, which it applies as of the refused drawing. The table gives no offer to the
   * novice profile or while checks are withheld, and then there is none.
   */
  function refuseOffering(context, code, values, runnable) {
    const offer = siblings().refusals.verdict(code, values, { checksReleased: context.checksReleased, profile: context.profile }).offer;
    return refuse(code, values, offer ? Object.assign({}, offer, runnable) : null);
  }

  /** The refusal of a second link from node `fromId` to node `toId`, with the offer to show the declared link's source. */
  function linkExists(fromId, toId, context) {
    return refuseOffering(context, 'link-exists', { 'Node A': nodeName(context, fromId), 'Node B': nodeName(context, toId) },
      { select: nodeSelection(context, fromId) });
  }

  /** A refusal the table has no row for, with its own words. */
  function refuseWith(words) {
    return { kind: 'refuse', code: words.code, values: {}, offer: null, summary: words.summary, message: words.message };
  }

  function commands(list, label, message, select = null, confirm = null) {
    return { kind: 'commands', commands: list, label, select, message, confirm };
  }

  function choose(label, options) {
    return { kind: 'form', form: 'choose', initial: { label, options }, placement: {} };
  }

  function nodeSelection(context, nodeId) {
    return { environmentId: environmentId(context), nodeId };
  }

  function insideNode(box, context) {
    return refuse('layout/inside-node', { Name: boxName(box, context), Parent: nodeName(context, box.kind === 'node' ? box.parentId : box.nodeId) });
  }

  function infrastructureLeaf(context, nodeId) {
    return refuse('infrastructure-leaf', { Node: nodeName(context, nodeId) });
  }

  function isInfrastructure(context, nodeId) {
    return nodeAt(context, nodeId).kind === 'infrastructure';
  }

  /** Whether the view keeps positions (the first move pinned its top-level nodes). */
  function holdsPositions(context) {
    return Boolean(context.layout && context.layout.positions.size > 0);
  }

  // ---- Adding nodes and hosting (spec §5.4 rows 1–3) ------------------------------------------------------

  /**
   * Add Node, Infrastructure node, or Host a container or system. The node it goes into is `operation.into` (a box's
   * alias: a node, or the node a hosted instance runs on), else, for a tile dropped on the drawing, the smallest node
   * drawn under the drop point. A node aimed at a node without being dropped there (a click or A with that node
   * focused) asks "Inside ‹node›" or "At the top level" first (spec §7.4). For Host, `operation.name` may name the
   * element to host; otherwise a chooser lists the ones the node does not host.
   */
  function planAdd(operation, context) {
    if (NOT_HOSTABLE_TOOLS.has(operation.tool)) return refuse('not-in-model/artifact');
    if (operation.tool === 'note') return refuse('not-in-model/note');
    const into = intoNodeOf(operation, context);
    if (operation.tool === 'host') return planHost(into, operation.name || null, context);
    if (!NODE_TOOLS.has(operation.tool)) throw new TypeError(`A deployment view has no element tool ${JSON.stringify(operation.tool)}`);
    const kind = operation.tool === 'infrastructure' ? 'infrastructure' : null;
    if (into === null) return addNode(kind, null, operation, context);
    if (operation.placed === 'dropped' || operation.placed === 'inside') {
      return isInfrastructure(context, into) ? infrastructureLeaf(context, into) : addNode(kind, into, operation, context);
    }
    return chooseNodePlace(kind, into, context);
  }

  /** The node id an addition goes into, or null for the top level. */
  function intoNodeOf(operation, context) {
    if (typeof operation.into === 'string') return landingNodeOf(operation.into, context);
    if (operation.into && typeof operation.into.id === 'string') return landingNodeOf(operation.into.id, context);
    const at = operation.placed === 'dropped' && operation.facts ? operation.facts.at : null;
    return at ? nodeUnder({ x: at.x + DROP_GRIP_UNITS, y: at.y + DROP_GRIP_UNITS }, context) : null;
  }

  /** The smallest drawn node whose box holds `point` (drawing units), or null. */
  function nodeUnder(point, context) {
    const rects = context.boxes || {};
    const holding = drawnBoxes(context).filter((box) => box.kind === 'node' && rects[box.alias] && contains(rects[box.alias], point));
    holding.sort((a, b) => area(rects[a.alias]) - area(rects[b.alias]));
    return holding.length > 0 ? holding[0].nodeId : null;
  }

  function contains(rect, point) {
    return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
  }

  function area(rect) {
    return rect.width * rect.height;
  }

  function chooseNodePlace(kind, nodeId, context) {
    const inside = { label: `Inside ${nodeName(context, nodeId)}`, place: { plan: 'add-node', kind, parentId: nodeId } };
    const top = { label: 'At the top level', place: { plan: 'add-node', kind, parentId: null } };
    if (!isInfrastructure(context, nodeId)) return choose('Add the new node', [inside, top]);
    return choose('Add the new node', [top, Object.assign({}, inside, unavailableWords(infrastructureLeaf(context, nodeId)))]);
  }

  /**
   * `addNode` named by its placeholder, with its position for a top-level node in a view that keeps positions or a
   * tile dropped at a point (the first move, which pins every top-level node where it is drawn; spec §6 rule 2).
   */
  function addNode(kind, parentId, operation, context) {
    const { C4, shared, layout } = siblings();
    const name = shared.placeholderName('node', kind);
    const add = { op: 'addNode', environmentId: environmentId(context), parentNodeId: parentId, name };
    if (kind !== null) add.kind = kind;
    const label = `Add ${name}`;
    const message = parentId === null ? `Added ${name} at the top level.` : `Added ${name} inside ${nodeName(context, parentId)}.`;
    const dryRun = C4.edit(context.design, add);
    if (dryRun.error) return commands([add], label, message);
    const select = nodeSelection(context, dryRun.selection.nodeId);
    const facts = (operation && operation.facts) || {};
    const dropped = Boolean(operation && operation.placed === 'dropped' && facts.at);
    if (parentId !== null || (!holdsPositions(context) && !dropped)) return commands([add], label, message, select);
    const at = dropped ? facts.at : layout.freePlace(context);
    const placing = layout.planMove({ positions: {}, routes: [], added: { [dryRun.selection.nodeId]: at }, facts }, context, view);
    if (placing.kind !== 'commands') return placing;
    return commands([add].concat(placing.commands), label, message, select);
  }

  /** Host a container or system on node `nodeId` (null: choose the node first), naming `elementId` or choosing it. */
  function planHost(nodeId, elementId, context) {
    if (nodeId === null) return chooseHostNode(context);
    if (isInfrastructure(context, nodeId)) return infrastructureLeaf(context, nodeId);
    if (elementId !== null) return hostOn(nodeId, elementId, context);
    const hosted = nodeAt(context, nodeId).hosts;
    const options = hostable(context).filter((element) => !hosted.includes(element.id)).map((element) => ({
      label: element.name || element.id, note: TYPE_WORDS[element.type], place: { plan: 'host', nodeId, elementId: element.id },
    }));
    if (options.length === 0) {
      return refuseWith({ code: 'nothing-to-host', summary: 'Hosts every container and system',
        message: `${nodeName(context, nodeId)} already hosts every container and software system of this design model.` });
    }
    return choose(`Host on ${nodeName(context, nodeId)}`, options);
  }

  function chooseHostNode(context) {
    const options = [...environment(context).nodes.values()].map((node) => (node.kind === 'infrastructure'
      ? Object.assign({ label: node.name }, unavailableWords(infrastructureLeaf(context, node.id)))
      : { label: node.name, place: { plan: 'host-node', nodeId: node.id } }));
    return choose('Host on which node?', options);
  }

  /** The containers and software systems of the model, in model order. */
  function hostable(context) {
    return [...model(context).elements.values()].filter((element) => HOSTABLE_TYPES.includes(element.type));
  }

  function hostOn(nodeId, elementId, context) {
    const node = nodeAt(context, nodeId);
    const element = model(context).elements.get(elementId);
    if (element && node.hosts.includes(elementId)) return refuse('already-hosted', { Node: node.name, Element: element.name || elementId });
    const name = element ? element.name || elementId : elementId;
    return commands([{ op: 'setHosts', environmentId: environmentId(context), nodeId, hosts: node.hosts.concat(elementId) }],
      `Host ${name} on ${node.name}`, `${name} now runs on ${node.name}.`, { elementId });
  }

  // ---- Nesting: Move to… and drops on a node (spec §5.4 rows 4–5) -----------------------------------------

  /**
   * Puts box `operation.ref` into the node `operation.parent` (a box's alias: a node, or the node a hosted instance
   * runs on) or, for null, at the top level; with `operation.choose`, first asks where ("Move to…").
   */
  function planReparent(operation, context) {
    const box = boxOf(operation.ref, context);
    if (operation.choose) return chooseNewParent(box, context);
    const parentId = operation.parent === null || operation.parent === undefined ? null
      : landingNodeOf(typeof operation.parent === 'object' ? operation.parent.id : operation.parent, context);
    return box.kind === 'node' ? moveNodeTo(box, parentId, context) : moveInstanceTo(box, parentId, context);
  }

  function moveNodeTo(box, parentId, context) {
    const name = boxName(box, context);
    const from = box.parentId;
    if (parentId === from) {
      return from === null
        ? refuseWith({ code: 'already-top-level', summary: 'Already at the top level', message: `${name} is already at the top level.` })
        : insideNode(box, context);
    }
    if (parentId !== null && (parentId === box.nodeId || isInside(context, parentId, box.nodeId))) return refuse('node-into-itself', { Node: name });
    if (parentId !== null && isInfrastructure(context, parentId)) return infrastructureLeaf(context, parentId);
    const move = { op: 'moveNode', environmentId: environmentId(context), nodeId: box.nodeId, newParentNodeId: parentId };
    const words = parentId === null ? `Moved ${name} out of ${nodeName(context, from)} to the top level`
      : `Moved ${name} into ${nodeName(context, parentId)}`;
    const placed = parentId === null && holdsPositions(context) ? freePlaceCommands(box.nodeId, context) : [];
    return commands([move].concat(placed), words, `${words}.`, nodeSelection(context, box.nodeId));
  }

  /** The layout write that gives node `nodeId`, arriving at the top level, a free place (spec §6 rule 2). */
  function freePlaceCommands(nodeId, context) {
    const { layout } = siblings();
    const placing = layout.planMove({ positions: {}, routes: [], added: { [nodeId]: layout.freePlace(context) }, facts: {} }, context, view);
    return placing.kind === 'commands' ? placing.commands : [];
  }

  /** A hosted instance onto another node: one batch of two `setHosts`, so one undo step. */
  function moveInstanceTo(box, parentId, context) {
    const name = boxName(box, context);
    if (parentId === null) {
      return refuseWith({ code: 'instance-needs-node', summary: 'Runs on a node',
        message: `${name} is drawn here because a node hosts it. Move it to another node, or host it there.` });
    }
    if (parentId === box.nodeId) return insideNode(box, context);
    if (isInfrastructure(context, parentId)) return infrastructureLeaf(context, parentId);
    const target = nodeAt(context, parentId);
    if (target.hosts.includes(box.elementId)) return refuse('already-hosted', { Node: target.name, Element: name });
    const source = nodeAt(context, box.nodeId);
    const id = environmentId(context);
    const words = `Moved ${name} from ${source.name} to ${target.name}`;
    return commands([
      { op: 'setHosts', environmentId: id, nodeId: source.id, hosts: source.hosts.filter((hosted) => hosted !== box.elementId) },
      { op: 'setHosts', environmentId: id, nodeId: target.id, hosts: target.hosts.concat(box.elementId) },
    ], words, `${words}.`, { elementId: box.elementId });
  }

  /**
   * "Move to…": every node, possible ones enabled and the others disabled with their short reason, and for a node
   * "At the top level (not inside a node)" first. The box's own place is left out.
   */
  function chooseNewParent(box, context) {
    const nodes = [...environment(context).nodes.values()].filter((node) => node.id !== (box.kind === 'node' ? box.parentId : box.nodeId)
      && !(box.kind === 'node' && node.id === box.nodeId));
    const options = nodes.map((node) => {
      const planned = box.kind === 'node' ? moveNodeTo(box, node.id, context) : moveInstanceTo(box, node.id, context);
      const option = { label: node.name, place: { plan: 'reparent', ref: box.alias, parentId: node.id } };
      return planned.kind === 'refuse' ? Object.assign(option, unavailableWords(planned)) : option;
    });
    if (box.kind === 'node' && box.parentId !== null) {
      options.unshift({ label: 'At the top level (not inside a node)', place: { plan: 'reparent', ref: box.alias, parentId: null } });
    }
    return choose(`Move ${boxName(box, context)} to`, options);
  }

  /** A chooser item's words for a refused choice: its short reason (`note`) and its sentence (`unavailable`). */
  function unavailableWords(refused) {
    const words = refused.message ? refused : siblings().refusals.verdict(refused.code, refused.values);
    return { note: words.summary || null, unavailable: words.message || words.summary };
  }

  // ---- Renaming, kinds, and deleting (spec §5.4 rows 6–8) -------------------------------------------------

  /** A node's name through the shared node rename (first-rename rule); a hosted element's model-wide. */
  function planRename(operation, context) {
    const box = boxOf(operation.ref, context);
    if (box.kind === 'node') {
      return { kind: 'action', action: 'renameNode', args: [environmentId(context), box.nodeId, operation.text], label: `Rename ${boxName(box, context)}` };
    }
    return { kind: 'action', action: 'renameElement', args: [box.elementId, operation.text, { wording: 'model-wide' }],
      label: `Rename ${boxName(box, context)}` };
  }

  /** A node's kind (from its menu, `changes.kind`, or `changes.choose: 'kind'` to ask); a stereotype is derived from it. */
  function planUpdate(operation, context) {
    const box = boxOf(operation.ref, context);
    const changes = operation.changes || {};
    if (box.kind !== 'node') return refuseWith({ code: 'derived/hosted-type', summary: 'Follows the model',
      message: `The keyword shows what ${boxName(box, context)} is, a container or a software system. It follows the model.` });
    if (changes.choose === 'kind') {
      const current = nodeAt(context, box.nodeId).kind;
      return choose(`Kind of ${boxName(box, context)}`, NODE_KINDS.filter((kind) => kind.value !== current)
        .map((kind) => ({ label: kind.label, place: { plan: 'kind', ref: box.alias, kind: kind.value } })));
    }
    if (typeof changes.kind !== 'string') return refuseWith({ code: 'derived/stereotype', summary: 'Shows the node\'s kind',
      message: 'The keyword shows the kind of this node. Change its kind in the node\'s menu or in the inspector.' });
    const node = nodeAt(context, box.nodeId);
    if (changes.kind === 'infrastructure' && (node.hosts.length > 0 || node.childIds.length > 0)) return infrastructureLeaf(context, node.id);
    const kind = NODE_KINDS.find((candidate) => candidate.value === changes.kind);
    return commands([{ op: 'updateNode', environmentId: environmentId(context), nodeId: node.id, field: 'kind', value: changes.kind }],
      `Change the kind of ${node.name}`, `${node.name} is now ${kind ? kind.phrase : changes.kind}.`, nodeSelection(context, node.id));
  }

  /** Deletes a node after a confirmation that lists what goes with it, or stops hosting an instance (spec §5.4). */
  function planRemoveElement(ref, context) {
    const box = boxOf(ref, context);
    const name = boxName(box, context);
    const id = environmentId(context);
    if (box.kind === 'instance') {
      const node = nodeAt(context, box.nodeId);
      return commands([{ op: 'setHosts', environmentId: id, nodeId: node.id, hosts: node.hosts.filter((hosted) => hosted !== box.elementId) }],
        `Stop hosting ${name} on ${node.name}`, `${name} no longer runs on ${node.name}; ${name} stays in the model.`, nodeSelection(context, node.id));
    }
    const details = removedWith(box.nodeId, context);
    const confirm = details.length === 0 ? null : {
      title: `Delete ${name}?`, message: `Deleting ${name} also deletes:`, details, confirmLabel: 'Delete',
    };
    const parent = nodeAt(context, box.nodeId).parentId;
    return commands([{ op: 'removeNode', environmentId: id, nodeId: box.nodeId }], `Delete ${name}`, `Deleted ${name}.`,
      parent ? nodeSelection(context, parent) : { environmentId: id }, confirm);
  }

  /** What a node's deletion takes with it: its nested nodes, the instances it and they host, and their links. */
  function removedWith(nodeId, context) {
    const env = environment(context);
    const removed = [];
    const visit = (id) => { removed.push(id); env.nodes.get(id).childIds.forEach(visit); };
    visit(nodeId);
    const nested = removed.slice(1).map((id) => `The nested node ${nodeName(context, id)}`);
    const hosted = removed.flatMap((id) => env.nodes.get(id).hosts.map((elementId) => `${elementName(context, elementId)} on ${nodeName(context, id)}`));
    const links = [...env.nodes.values()].flatMap((node) => node.relationships
      .filter((link) => removed.includes(node.id) || removed.includes(link.targetId))
      .map((link) => `The link from ${node.name} to ${nodeName(context, link.targetId)}`));
    return nested.concat(hosted, links);
  }

  function planRemoveSelection(operation, context) {
    const elements = operation.elements || [];
    const relations = operation.relations || [];
    const count = elements.length + relations.length + (operation.fragments || []).length + (operation.activations || []).length;
    if (count !== 1) return refuseWith(ONE_AT_A_TIME);
    if (elements.length === 1) return planRemoveElement(typeof elements[0] === 'object' ? elements[0].id : elements[0], context);
    const link = linkOf(relations[0], context);
    if (link.derived) return derivedPath(link, context);
    const words = `the link from ${nodeName(context, link.from)} to ${nodeName(context, link.to)}`;
    return commands([{ op: 'removeNodeLink', environmentId: environmentId(context), nodeId: link.from, targetNodeId: link.to }],
      `Delete ${words}`, `Deleted ${words}.`, nodeSelection(context, link.from));
  }

  // ---- Lines: links between nodes, relationships between hosted elements (spec §5.4 rows 9–13) ------------

  /** The refusal of an edit of a derived path, which names the relationship it is drawn from (spec §5.1). */
  function derivedPath(link, context) {
    const relationship = derivedSource(link, context);
    return refuseOffering(context, 'derived/path', {
      Source: relationship ? elementName(context, relationship.sourceId) : endName(link.from, context),
      Target: relationship ? elementName(context, relationship.targetId) : endName(link.to, context),
      description: relationship && relationship.description ? relationship.description : 'no description',
    }, relationship ? { select: { relationshipId: relationship.id } } : {});
  }

  /** Draws a line: a link between two nodes through the link form, a relationship between two hosted elements. */
  function planRelationAdd(operation, context) {
    const source = boxOf(operation.from, context);
    const target = boxOf(operation.to, context);
    if (!RELATION_TOOLS.some((tool) => tool.id === operation.tool)) throw new TypeError(`A deployment view has no line tool ${JSON.stringify(operation.tool)}`);
    if (source.kind !== target.kind) return refuse('link-ends');
    if (source.kind === 'node') return operation.tool === 'link' ? addLink(source.nodeId, target.nodeId, context) : refuseWith(RELATIONSHIP_ENDS);
    if (operation.tool === 'link') return refuse('link-ends');
    return addRelationship(source, target, context);
  }

  /** The link form for a new link from node `fromId` to node `toId`, or why there can be none. */
  function addLink(fromId, toId, context) {
    if (fromId === toId) return refuse('link-self', { Node: nodeName(context, fromId) });
    if (declaredLink(context, fromId, toId)) return linkExists(fromId, toId, context);
    return { kind: 'form', form: 'link', placement: {}, initial: {
      title: 'Add a link', submitLabel: 'Add', sourceName: nodeName(context, fromId), targetName: nodeName(context, toId),
      description: '', technology: '', link: { mode: 'add', nodeId: fromId, targetNodeId: toId },
    } };
  }

  /**
   * A relationship between the elements of two hosted instances, through the shared relationship form, whose lead
   * says that it adds a relationship to the model and, when node links already carry it, that no line will appear
   * and which links carry it (spec §5.1). Two copies of one element are refused; so is a second relationship from
   * one element to the other, with the shared action's words and, when node links hide the line, the links.
   */
  function addRelationship(source, target, context) {
    if (source.elementId === target.elementId) {
      return refuseOffering(context, 'same-element-instances',
        { Element: elementName(context, source.elementId), 'Node A': nodeName(context, source.nodeId), 'Node B': nodeName(context, target.nodeId) },
        { operation: { op: 'relation.add', tool: 'link', from: nodeAliasOf(source.nodeId, context), to: nodeAliasOf(target.nodeId, context), label: null } });
    }
    const { shared } = siblings();
    const ends = shared.endsProblem(model(context), source.elementId, target.elementId);
    if (ends) return refuseWith({ code: ends.code, summary: END_SUMMARIES[ends.code] || null, message: ends.message });
    const carriers = carryingLinks(source.nodeId, target.nodeId, context);
    const carried = carriers ? ` No line appears here for it: ${linksPhrase(carriers, context)} already ${carriers.length === 1 ? 'leads' : 'lead'} from ${nodeName(context, source.nodeId)} to ${nodeName(context, target.nodeId)}.` : '';
    const declared = model(context).relationships.find((candidate) => candidate.sourceId === source.elementId && candidate.targetId === target.elementId);
    if (declared) {
      const [from, to] = [elementName(context, source.elementId), elementName(context, target.elementId)];
      const named = declared.description === null ? 'one without a description' : `'${declared.description}'`;
      return refuseWith({ code: 'duplicate', summary: 'Already related',
        message: `Error: ${from} already has a relationship to ${to}: ${named}. Edit that one instead.${carried}` });
    }
    const lead = `This adds a relationship to the model: it appears in the C4 views of both elements.${carried}`;
    return { kind: 'action', action: 'openRelationshipForm', args: [{ sourceId: source.elementId, targetId: target.elementId }, { lead }],
      label: 'Add a relationship' };
  }

  /**
   * The declared links that lead from node `fromId` to node `toId`, directly or through other nodes, in order (the
   * projection's rule for a relationship it does not draw, C4 spec §6.3); null when none do.
   */
  function carryingLinks(fromId, toId, context) {
    const env = environment(context);
    const cameFrom = new Map([[fromId, null]]);
    const pending = [fromId];
    while (pending.length > 0) {
      const nodeId = pending.shift();
      for (const link of env.nodes.get(nodeId).relationships) {
        if (cameFrom.has(link.targetId)) continue;
        cameFrom.set(link.targetId, nodeId);
        if (link.targetId === toId) return pathTo(cameFrom, toId);
        pending.push(link.targetId);
      }
    }
    return null;
  }

  function pathTo(cameFrom, toId) {
    const path = [];
    for (let at = toId; cameFrom.get(at) !== null; at = cameFrom.get(at)) path.unshift({ from: cameFrom.get(at), to: at });
    return path;
  }

  /** "the link from A to B", or "the links from A to B and from B to C". */
  function linksPhrase(links, context) {
    const parts = links.map((link) => `from ${nodeName(context, link.from)} to ${nodeName(context, link.to)}`);
    return links.length === 1 ? `the link ${parts[0]}` : `the links ${siblings().shared.namesList(parts)}`;
  }

  /** Editing a declared link opens the link form with its fields; a derived path says what it is drawn from. */
  function planRelationUpdate(operation, context) {
    const link = linkOf(operation.ref, context);
    if (link.derived) return derivedPath(link, context);
    const declared = declaredLink(context, link.from, link.to);
    return { kind: 'form', form: 'link', placement: {}, initial: {
      title: 'Edit link', submitLabel: 'Save', sourceName: nodeName(context, link.from), targetName: nodeName(context, link.to),
      description: declared.description || '', technology: declared.technology || '',
      link: { mode: 'edit', nodeId: link.from, targetNodeId: link.to },
    } };
  }

  /** Moves one end of a declared link to node `operation.to`: the old link goes, the new one keeps its fields. */
  function planRewire(operation, context) {
    const link = linkOf(operation.ref, context);
    if (link.derived) return derivedPath(link, context);
    const box = boxOf(operation.to, context);
    if (box.kind !== 'node') return refuse('link-ends');
    const [fromId, toId] = operation.end === 'source' ? [box.nodeId, link.to] : [link.from, box.nodeId];
    if (fromId === link.from && toId === link.to) {
      return refuseWith({ code: 'already-there', summary: 'The end is there already', message: `The link already ends at ${nodeName(context, box.nodeId)}.` });
    }
    const words = `Move an end of the link from ${nodeName(context, link.from)} to ${nodeName(context, link.to)}`;
    return replaceLink(link, fromId, toId, context, words, `The link now runs from ${nodeName(context, fromId)} to ${nodeName(context, toId)}.`);
  }

  function planInvert(operation, context) {
    const link = linkOf(operation.ref, context);
    if (link.derived) return derivedPath(link, context);
    return replaceLink(link, link.to, link.from, context, `Turn the link from ${nodeName(context, link.from)} to ${nodeName(context, link.to)} around`,
      `The link now runs from ${nodeName(context, link.to)} to ${nodeName(context, link.from)}.`);
  }

  /** `batch[removeNodeLink, setNodeLink]` from `fromId` to `toId` with the old link's description and technology. */
  function replaceLink(link, fromId, toId, context, label, message) {
    if (fromId === toId) return refuse('link-self', { Node: nodeName(context, fromId) });
    if (declaredLink(context, fromId, toId)) return linkExists(fromId, toId, context);
    const declared = declaredLink(context, link.from, link.to);
    const id = environmentId(context);
    return commands([
      { op: 'removeNodeLink', environmentId: id, nodeId: link.from, targetNodeId: link.to },
      { op: 'setNodeLink', environmentId: id, nodeId: fromId, targetNodeId: toId, description: declared.description || null, technology: declared.technology || null },
    ], label, message, nodeSelection(context, fromId));
  }

  // ---- Layout (spec §5.4 rows 14–15, §6) --------------------------------------------------------------------

  /**
   * A move: top-level nodes keep positions (the layout planner writes them); a nested node or a hosted instance
   * dropped anywhere but on a node is refused with `layout/inside-node`. A nested box left where it is drawn moves
   * nothing: the module asks so when a drag starts (its operation's facts carry no positions yet), and a press that
   * moved nothing drops it there. Asked without any facts (a menu's or the inspector's probe), a nested box is refused.
   */
  function planLayoutSet(operation, context) {
    const holders = view.holders(context);
    const positions = Object.assign({}, operation.positions || {});
    const facts = operation.facts;
    for (const alias of Object.keys(positions)) {
      if (holders.has(alias)) continue;
      const box = boxOf(alias, context);
      if (!facts || !stayed(alias, positions[alias], facts)) return insideNode(box, context);
      delete positions[alias];
    }
    if (Object.keys(positions).length === 0 && (operation.routes || []).length === 0) return commands([], null, null);
    return siblings().layout.planMove({ positions, routes: operation.routes, facts: facts || {} }, context, view);
  }

  /** Whether box `alias` is at `place` where the drawing has it (true when the facts have no drawn places yet). */
  function stayed(alias, place, facts) {
    const drawn = facts.positions ? facts.positions[alias] : undefined;
    if (!facts.positions) return true;
    if (!drawn) return false;
    const [x, y] = Array.isArray(place) ? place : [place.x, place.y];
    const [dx, dy] = Array.isArray(drawn) ? drawn : [drawn.x, drawn.y];
    return Math.abs(x - dx) < SAME_PLACE_UNITS && Math.abs(y - dy) < SAME_PLACE_UNITS;
  }

  function planLayoutReset(operation, context) {
    const target = operation.target;
    if (target && target.element && !view.holders(context).has(target.element)) return insideNode(boxOf(target.element, context), context);
    return siblings().layout.planReset(target, context);
  }

  const PLANNERS = {
    'element.add': planAdd,
    'element.rename': planRename,
    'element.update': planUpdate,
    'element.duplicate': () => refuse('not-in-model/duplicate'),
    'element.remove': (operation, context) => planRemoveElement(operation.ref, context),
    'element.reparent': planReparent,
    'selection.remove': planRemoveSelection,
    'relation.add': planRelationAdd,
    'relation.update': planRelationUpdate,
    'relation.rewire': planRewire,
    'relation.invert': planInvert,
    'layout.set': planLayoutSet,
    'layout.reset': planLayoutReset,
  };

  /** What `operation` means in this deployment view: a plan for the C4 model adapter (plan Task 34). */
  function plan(operation, context) {
    const planner = PLANNERS[operation.op];
    if (!planner) throw new TypeError(`A deployment view plans no ${operation.op}`);
    return planner(operation, context);
  }

  /**
   * The plan of a form's answer. `choose` gives the chosen option, whose `place` says what was chosen; `link` gives the
   * link form's fields with the link it was opened for (see the form in c4-editor-inspector-deployment.js).
   */
  function fromForm(form, values, context) {
    if (form === 'link') return linkFromForm(values, context);
    if (form !== 'choose') throw new TypeError(`A deployment view has no form ${JSON.stringify(form)}`);
    const place = values.place;
    if (place.plan === 'add-node') return addNode(place.kind, place.parentId, null, context);
    if (place.plan === 'host-node') return planHost(place.nodeId, null, context);
    if (place.plan === 'host') return hostOn(place.nodeId, place.elementId, context);
    if (place.plan === 'kind') return planUpdate({ ref: place.ref, changes: { kind: place.kind } }, context);
    return planReparent({ ref: place.ref, parent: place.parentId === null ? null : nodeAliasOf(place.parentId, context) }, context);
  }

  function linkFromForm(values, context) {
    const { mode, nodeId, targetNodeId } = values.link;
    const description = (values.description || '').trim() || null;
    const technology = (values.technology || '').trim() || null;
    const words = `the link from ${nodeName(context, nodeId)} to ${nodeName(context, targetNodeId)}`;
    const command = { op: 'setNodeLink', environmentId: environmentId(context), nodeId, targetNodeId, description, technology };
    if (mode === 'edit') return commands([Object.assign(command, { replace: true })], `Edit ${words}`, `Changed ${words}.`, nodeSelection(context, nodeId));
    // The values the table's sentences of the core's link refusals (link-self, link-exists) are filled with.
    const refusalValues = { 'Node A': nodeName(context, nodeId), 'Node B': nodeName(context, targetNodeId), Node: nodeName(context, nodeId) };
    return Object.assign(commands([command], `Link ${nodeName(context, nodeId)} to ${nodeName(context, targetNodeId)}`, `Added ${words}.`,
      nodeSelection(context, nodeId)), { values: refusalValues });
  }

  // ---- Advice for gestures with an open end (spec §3.4 `targets`) -----------------------------------------

  /**
   * Advice for a gesture with one open end: each drawn box as a line's end (`from`, `to`), each node as the new parent
   * of a moved box (`parent`), or as where a tile goes (`into`), with the refusal its plan gives. Null otherwise.
   */
  function targets(request, context) {
    if (OPEN_ENDS.includes(request.open)) {
      return drawnBoxes(context).map((box) => advice(box.alias, plannedEnd(Object.assign({}, request, { [request.open]: box.alias }), context)));
    }
    if (request.open === 'parent') {
      // A drop on a hosted element lands on the node it runs on, so each box is advised as that node.
      const moved = boxOf(request.ref, context);
      return drawnBoxes(context).filter((box) => box.alias !== moved.alias)
        .map((box) => advice(box.alias, planReparent({ ref: request.ref, parent: box.alias }, context)));
    }
    if (request.open === 'into') {
      return drawnBoxes(context).filter((box) => box.kind === 'node')
        .map((box) => advice(box.alias, planAdd(Object.assign({}, request, { into: box.alias, placed: 'dropped' }), context)));
    }
    return null;
  }

  function advice(ref, planned) {
    const refused = planned.kind === 'refuse';
    return { ref, ok: !refused, code: refused ? planned.code : null, values: refused ? planned.values : undefined,
      summary: refused && planned.summary ? planned.summary : undefined };
  }

  /**
   * The plan of one candidate end. A line drawn without a kind yet (`relation.add` without `tool`: C mode, whose
   * chooser offers the kinds that fit the pair) is possible when either kind is; when neither is, the refusal is the
   * one of the kind its first end could have: a link from a node, a relationship from a hosted element.
   */
  function plannedEnd(operation, context) {
    if (operation.op !== 'relation.add' || operation.tool) return plan(operation, context);
    const [link, relationship] = RELATION_TOOLS.map((tool) => plan(Object.assign({}, operation, { tool: tool.id }), context));
    if (link.kind !== 'refuse') return link;
    if (relationship.kind !== 'refuse') return relationship;
    return boxOf(operation.from, context).kind === 'node' ? link : relationship;
  }

  // ---- What the view offers (spec §7.3, §5.6) -------------------------------------------------------------

  function tools() {
    return {
      elements: ELEMENT_TOOLS.map((tool) => Object.assign({}, tool)),
      relations: RELATION_TOOLS.map((tool) => Object.assign({}, tool)),
      unavailable: UNAVAILABLE_TOOLS.map((tool) => Object.assign({}, tool)),
    };
  }

  /**
   * The option sets of the listbox (spec §7.3): "Nodes", "Hosted", and "Links", each left out when the drawing has
   * none. A node says its kind, technology, number of instances, and whether it is inside a node or at the top level;
   * a hosted element its type and technology; a link whether it is declared or derived, and from which relationship.
   */
  function optionSets(context) {
    const boxes = drawnBoxes(context);
    const kept = context.layout ? context.layout.positions : new Map();
    const sets = [
      { id: 'nodes', label: 'Nodes', options: boxes.filter((box) => box.kind === 'node').map((box) => nodeOption(box, kept, context)) },
      { id: 'hosted', label: 'Hosted', options: boxes.filter((box) => box.kind === 'instance').map((box) => hostedOption(box, context)) },
      { id: 'links', label: 'Links', options: drawnLinks(context).map((link) => linkOption(link, context)) },
    ];
    return sets.filter((set) => set.options.length > 0);
  }

  function nodeOption(box, kept, context) {
    const node = nodeAt(context, box.nodeId);
    const words = [NODE_KIND_WORDS[node.kind] || 'node', node.technology, node.instances > 1 ? `${node.instances} instances` : null,
      box.parentId === null ? 'at the top level' : `inside ${nodeName(context, box.parentId)}`, kept.has(box.nodeId) ? 'position kept' : null];
    return { ref: box.alias, name: node.name, description: words.filter(Boolean).join('; ') };
  }

  function hostedOption(box, context) {
    const element = model(context).elements.get(box.elementId);
    return {
      ref: box.alias, name: `${element.name || element.id} on ${nodeName(context, box.nodeId)}`,
      description: [TYPE_WORDS[element.type] || element.type, element.technology].filter(Boolean).join('; '),
    };
  }

  function linkOption(link, context) {
    const { shared } = siblings();
    if (!link.derived) {
      const declared = declaredLink(context, link.from, link.to);
      return { ref: link.ref, name: shared.sentence(nodeName(context, link.from), declared.description, nodeName(context, link.to), declared.technology),
        description: 'declared link' };
    }
    const relationship = derivedSource(link, context);
    return {
      ref: link.ref,
      name: shared.sentence(endName(link.from, context), relationship ? relationship.description : null, endName(link.to, context), null),
      description: relationship
        ? `derived from the relationship from ${elementName(context, relationship.sourceId)} to ${elementName(context, relationship.targetId)}; follows the model`
        : 'derived; follows the model',
    };
  }

  /** Only top-level nodes hold positions (spec §4.2, §14 D4); what is inside a node follows it. */
  function holders(context) {
    return new Set(drawnBoxes(context).filter((box) => box.kind === 'node' && box.parentId === null).map((box) => box.alias));
  }

  /** Why box `ref` holds no position (`layout/inside-node`), or null; every link can hold a bend. */
  function layoutRefusal(ref, context) {
    if (typeof ref !== 'string' || LINE_REF.test(ref)) return null;
    const box = boxOf(ref, context);
    if (box.kind === 'node' && box.parentId === null) return null;
    const refused = insideNode(box, context);
    return { code: refused.code, values: refused.values };
  }

  /**
   * The view's items in a box's menu (spec §7.4): "Move to…"; for a node that can hold things, adding a node inside
   * it and hosting a container or system on it; and its kind. A line has none of its own.
   */
  function menu(ref, context) {
    if (typeof ref !== 'string' || LINE_REF.test(ref)) return [];
    const box = boxOf(ref, context);
    const items = [{ label: 'Move to…', operation: { op: 'element.reparent', ref, parent: null, choose: true } }];
    if (box.kind !== 'node') return items;
    const name = boxName(box, context);
    if (!isInfrastructure(context, box.nodeId)) {
      items.push(
        { label: `Add a node inside ${name}`, operation: { op: 'element.add', tool: 'node', name: null, into: ref, anchor: null, placed: 'inside' } },
        { label: `Host a container or system on ${name}…`, operation: { op: 'element.add', tool: 'host', name: null, into: ref, anchor: null, placed: 'inside' } });
    }
    items.push({ label: 'Change kind…', operation: { op: 'element.update', ref, changes: { choose: 'kind' } } });
    return items;
  }

  /** The selection an option stands for: a node, the element of a hosted instance, a link's source node or relationship. */
  function selectionOf(ref, context) {
    if (typeof ref === 'string' && LINE_REF.test(ref)) {
      const link = drawnLinks(context).find((candidate) => candidate.ref === ref);
      if (!link) return null;
      return link.derived ? { relationshipId: link.relationshipIds[0] } : nodeSelection(context, link.from);
    }
    const box = drawnBoxes(context).find((candidate) => candidate.alias === ref);
    if (!box) return null;
    return box.kind === 'node' ? nodeSelection(context, box.nodeId) : { elementId: box.elementId };
  }

  /** The option a selection from the outline or a form stands for, or null when the drawing has none. */
  function refOf(selection, context) {
    if (!selection) return null;
    if (selection.nodeId && (!selection.environmentId || selection.environmentId === environmentId(context))) return nodeAliasOf(selection.nodeId, context);
    if (selection.elementId) {
      const box = drawnBoxes(context).find((candidate) => candidate.kind === 'instance' && candidate.elementId === selection.elementId);
      return box ? box.alias : null;
    }
    if (selection.relationshipId) {
      const link = drawnLinks(context).find((candidate) => candidate.derived && candidate.relationshipIds.includes(selection.relationshipId));
      return link ? link.ref : null;
    }
    return null;
  }

  const view = {
    notation: NOTATION, editable: true, optionSets, tools, plan, fromForm, targets, holders, layoutRefusal, menu, selectionOf, refOf,
  };
  return view;
});
