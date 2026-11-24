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

  // The view module of interfaces views, `interfaces of ‹element›`, drawn as UML component diagrams (UML-view editing
  // spec §5.5, §4.2, §14 D3; plan Task 46). It tells the canvas what an interfaces view offers (option sets, tools,
  // which boxes hold a position) and plans what each operation of the diagram editor means in design.yml. It decides
  // nothing the C4 core decides: the C4 model adapter (c4-editor-uml-adapter.js) runs a plan's commands as one batch
  // after a dry run and the lock check, calls the shared action a plan names, and words every refusal by the refusal
  // table. Siblings are read at call time (the core, the shared action helpers, the layout planner, the refusal
  // table), so this file loads in any order.
  //
  // Every member takes the canvas's `context` (plan Task 34): `{ design, viewModel, uml, profile, checksReleased,
  // revision, layout }`. toUml names the drawing's boxes e1, e2, … (the consumers, the subject, the providers), its
  // balls p1, p2, … and its sockets r1, r2, … (c4-uml.js `componentDiagram`); `uml.ids` maps each to the element or
  // interface it stands for. A line between a ball and its socket (an assembly: one consumer's use of one interface)
  // is named by `rel:<n>`, the line of the drawn text without its layout block that the source map (spec §4.1) gives
  // the assembly; an operation's relation reference `{ routeId, line, candidates }` names it by `line`.
  //
  // What the view draws is derived from what elements provide and use: a neighbour box is there because of an
  // interface, a ball sits on its provider's box, and a line is the uses entries of the relationships behind it. So a
  // box or a line is never deleted as such; only what the subject declares is renamed or removed here, and a use is
  // added or deleted through the `uses` of a relationship (§5.5).

  const NOTATION = 'uml-component';
  const BOX = /^e\d+$/;
  const BALL = /^p\d+$/;
  const SOCKET = /^r\d+$/;
  const LINE_REF = /^rel:(\d+)$/;
  const OPEN_ENDS = ['from', 'to'];

  // The palette (spec §5.5; the provided interface's tool id as the UML editor's component palette names it).
  const ELEMENT_TOOLS = [{ id: 'provide', label: 'Provided interface', glyph: '○' }];
  const RELATION_TOOLS = [{ id: 'use', label: 'Use an interface', glyph: '⊃○' }];
  // The UML editor's other component tools: a box appears here through an interface, and this design model has no
  // ports or notes (spec §5.6). Port In and Port Out are its two port tools.
  const UNAVAILABLE_TOOLS = [
    { id: 'component', label: 'Component', code: 'interfaces/add-element' },
    { id: 'port', label: 'Port', code: 'not-in-model/port' },
    { id: 'note', label: 'Note', code: 'not-in-model/note' },
  ];
  const UNAVAILABLE_ADDITIONS = { component: 'interfaces/add-element', port: 'not-in-model/port', portin: 'not-in-model/port',
    portout: 'not-in-model/port', note: 'not-in-model/note' };
  // The option sets in reading order: the boxes as today's read-only listbox names them (consumers, the subject,
  // providers; C4 spec §5.3), then the balls and the lines.
  const BOX_SETS = [
    { id: 'consumers', role: 'consumer', label: (scope) => `Using what ${scope} provides` },
    { id: 'subject', role: 'scope', label: () => 'Subject of this view' },
    { id: 'providers', role: 'provider', label: (scope) => `Providing what ${scope} requires` },
  ];
  const MODEL_WIDE = { wording: 'model-wide' };
  // A refusal the table has no row for, worded as the code, deployment, and dynamic views word it: a view deletes one
  // drawn thing at a time (the C4 surface selects one; the module's `remove(refs)` could pass several).
  const ONE_AT_A_TIME = { code: 'one-at-a-time', summary: 'Delete one thing at a time',
    message: 'Select one box, interface, or use and delete it; this view deletes one thing at a time.' };

  // ---- Reading the drawing --------------------------------------------------------------------------------

  function model(context) {
    return context.design.model;
  }

  function scopeId(context) {
    return context.viewModel.scopeId;
  }

  function nameOf(context, id) {
    return siblings().shared.elementName(model(context), id);
  }

  function interfaceName(context, interfaceId) {
    const declared = model(context).interfaces.get(interfaceId);
    return declared ? declared.name || interfaceId : interfaceId;
  }

  /**
   * The drawing's boxes, balls, sockets, and lines, read from the source map: `boxes` (`{ alias, id, role }`), `ports`
   * (`{ alias, kind: 'ball' | 'socket', interfaceId, elementId, consumerId }`; a ball's `consumerId` is the consumer of
   * its line, null for a ball nobody uses), and `lines` (`{ ref, index, interfaceId, providerId, consumerId }`).
   * toUml numbers balls and sockets in the order it writes their rows, so the n-th provided port is `p<n>`.
   */
  function drawn(context) {
    const reading = { boxes: [], ports: [], lines: [] };
    const counters = { ball: 0, socket: 0 };
    context.uml.source.lines.forEach((entry, index) => {
      if (!entry) return;
      if (entry.kind === 'element') {
        const alias = Object.keys(context.uml.ids).find((candidate) => BOX.test(candidate) && context.uml.ids[candidate] === entry.id);
        if (alias) reading.boxes.push({ alias, id: entry.id, role: entry.role });
      } else if (entry.kind === 'port') {
        const kind = entry.role === 'provided' ? 'ball' : 'socket';
        counters[kind] += 1;
        reading.ports.push({ alias: `${kind === 'ball' ? 'p' : 'r'}${counters[kind]}`, kind, interfaceId: entry.interfaceId,
          elementId: entry.elementId, consumerId: entry.consumerId });
      } else if (entry.kind === 'assembly') {
        reading.lines.push({ ref: `rel:${index}`, index, interfaceId: entry.interfaceId, providerId: entry.providerId, consumerId: entry.consumerId });
      }
    });
    return reading;
  }

  /** The drawn box `alias`: `{ alias, id, role }`; a TypeError when the drawing has no such box. */
  function boxOf(alias, context) {
    const box = drawn(context).boxes.find((candidate) => candidate.alias === alias);
    if (!box) throw new TypeError(`The interfaces view draws no box ${JSON.stringify(alias)}`);
    return box;
  }

  /** The drawn ball or socket `alias`; a TypeError when the drawing has no such port. */
  function portOf(alias, context) {
    const port = drawn(context).ports.find((candidate) => candidate.alias === alias);
    if (!port) throw new TypeError(`The interfaces view draws no ball or socket ${JSON.stringify(alias)}`);
    return port;
  }

  /** The drawn line a reference names (a `rel:<n>` ref, or an operation's `{ line, candidates }`). */
  function lineOf(ref, context) {
    const index = lineIndex(ref);
    const line = drawn(context).lines.find((candidate) => candidate.index === index);
    if (!line) throw new TypeError(`Line ${index} of the interfaces view is no line between a ball and a socket`);
    return line;
  }

  function lineIndex(ref) {
    if (typeof ref === 'string' && LINE_REF.test(ref)) return Number(LINE_REF.exec(ref)[1]);
    if (ref && Number.isInteger(ref.line) && ref.line >= 0) return ref.line;
    if (ref && Array.isArray(ref.candidates) && ref.candidates.length === 1) return lineIndex(ref.candidates[0]);
    if (Number.isInteger(ref) && ref >= 0) return ref;
    throw new TypeError('An interfaces view acts on one line: the C4 surface chooses among the lines that meet at a point first');
  }

  function isSameOrInside(context, id, ancestorId) {
    const elements = model(context).elements;
    for (let element = elements.get(id); element; element = element.parentId === null ? null : elements.get(element.parentId)) {
      if (element.id === ancestorId) return true;
    }
    return false;
  }

  /**
   * The relationships behind a line: those that start at its consumer or inside it, leave it, and write a use of its
   * interface (an inherited use is written elsewhere and is left out). In document order.
   */
  function relationshipsBehind(line, context) {
    return model(context).relationships.filter((relationship) => isSameOrInside(context, relationship.sourceId, line.consumerId)
      && !isSameOrInside(context, relationship.targetId, line.consumerId)
      && relationship.uses.some((use) => use.interfaceId === line.interfaceId && !use.inherited));
  }

  /** The `uses` entries a relationship writes itself, as text. */
  function writtenUses(relationship) {
    return relationship.uses.filter((use) => !use.inherited).map((use) => use.text);
  }

  // ---- Refusals -------------------------------------------------------------------------------------------

  function refuse(code, values = {}, offer = null) {
    return { kind: 'refuse', code, values, offer };
  }

  function refuseWith(words) {
    return { kind: 'refuse', code: words.code, values: {}, offer: null, summary: words.summary, message: words.message };
  }

  /**
   * An interface declared on another element than the subject: renamed, removed, or added in its owner's interfaces
   * view (spec §5.5), which the offer opens. `interfaceText` names the interface in the sentence; null for an addition,
   * which names no interface yet, so the table words it as one.
   */
  function declaredElsewhere(interfaceText, ownerId, context) {
    const values = interfaceText === null ? { Owner: nameOf(context, ownerId) } : { Interface: interfaceText, Owner: nameOf(context, ownerId) };
    const offer = siblings().refusals.verdict('interfaces/declared-elsewhere', values).offer;
    return refuse('interfaces/declared-elsewhere', values, offer ? Object.assign({}, offer, { view: `interfaces of ${ownerId}` }) : null);
  }

  /** The refusal of an interface the subject does not declare, or null when the subject declares it. */
  function ownerRefusal(interfaceId, context) {
    const declared = model(context).interfaces.get(interfaceId);
    if (!declared || declared.providerId === scopeId(context)) return null;
    return declaredElsewhere(interfaceName(context, interfaceId), declared.providerId, context);
  }

  /** A neighbour box is drawn because it uses an interface of the subject, or provides one the subject uses. */
  function neighbourRefusal(box, context) {
    const line = drawn(context).lines.find((candidate) => candidate.consumerId === box.id || candidate.providerId === box.id);
    const uses = Boolean(line && line.consumerId === box.id);
    return refuse('interfaces/neighbour', {
      Name: nameOf(context, box.id), 'uses | provides': uses ? 'uses' : 'provides', Interface: line ? interfaceName(context, line.interfaceId) : '',
    });
  }

  function assemblyEnds() {
    return refuse('interfaces/assembly-ends');
  }

  function addElementRefusal(context) {
    return refuse('interfaces/add-element', { Scope: nameOf(context, scopeId(context)) });
  }

  function commands(list, label, message, select = null, confirm = null) {
    return { kind: 'commands', commands: list, label, select, message, confirm };
  }

  // ---- Plans, one per operation (spec §5.5) ---------------------------------------------------------------

  /**
   * Add a provided interface to the subject: `addInterface` with the placeholder name, which the first rename turns
   * into the interface's id too (spec §5.1, §14 D1). A shorthand provides list is expanded by the same command.
   */
  function planAdd(operation, context) {
    if (UNAVAILABLE_ADDITIONS[operation.tool]) {
      const code = UNAVAILABLE_ADDITIONS[operation.tool];
      return code === 'interfaces/add-element' ? addElementRefusal(context) : refuse(code);
    }
    if (operation.tool !== 'provide') throw new TypeError(`An interfaces view has no element tool ${JSON.stringify(operation.tool)}`);
    const { C4, shared } = siblings();
    const name = operation.name || shared.placeholderName('interface');
    const ownerId = operation.into ? boxOf(operation.into, context).id : scopeId(context);
    if (ownerId !== scopeId(context)) return declaredElsewhere(null, ownerId, context);
    const add = { op: 'addInterface', elementId: ownerId, name };
    const dryRun = C4.edit(context.design, add);
    const select = dryRun.error ? null : { interfaceId: dryRun.selection.interfaceId };
    return commands([add], `Add an interface to ${nameOf(context, ownerId)}`, `Added ${name} to ${nameOf(context, ownerId)}.`, select);
  }

  /** A box is renamed in the whole model; a ball or socket renames its interface, when the subject declares it. */
  function planRename(operation, context) {
    if (BOX.test(operation.ref)) {
      const box = boxOf(operation.ref, context);
      return { kind: 'action', action: 'renameElement', args: [box.id, operation.text, MODEL_WIDE], label: `Rename ${nameOf(context, box.id)}` };
    }
    const port = portOf(operation.ref, context);
    const refused = ownerRefusal(port.interfaceId, context);
    if (refused) return refused;
    return { kind: 'action', action: 'renameInterface', args: [port.interfaceId, operation.text, MODEL_WIDE],
      label: `Rename ${interfaceName(context, port.interfaceId)}` };
  }

  /**
   * Deletes what `ref` stands for: the subject through the shared delete; a neighbour box is derived from an
   * interface and is refused; a ball removes its interface after a confirmation; a socket deletes its uses.
   */
  function planRemoveElement(ref, context) {
    if (BOX.test(ref)) {
      const box = boxOf(ref, context);
      if (box.id !== scopeId(context)) return neighbourRefusal(box, context);
      return { kind: 'action', action: 'deleteElement', args: [box.id, MODEL_WIDE], label: `Delete ${nameOf(context, box.id)}` };
    }
    const port = portOf(ref, context);
    // A socket is its element's use of the interface, whether or not the view draws the provider's ball for it.
    if (port.kind === 'socket') return planRemoveUses([{ interfaceId: port.interfaceId, consumerId: port.elementId }], context);
    const refused = ownerRefusal(port.interfaceId, context);
    return refused || planRemoveInterface(port.interfaceId, context);
  }

  /**
   * `removeInterface` after a confirmation. An interface something uses loses those uses with it (C4 spec §4.10):
   * the confirmation lists them.
   */
  function planRemoveInterface(interfaceId, context) {
    const name = interfaceName(context, interfaceId);
    const owner = nameOf(context, scopeId(context));
    const dependents = siblings().C4.interfaceDependentsOf(context.design, interfaceId);
    const lead = dependents.length === 0
      ? `${owner} stops providing ${name}. Nothing uses it.`
      : `${owner} stops providing ${name}, and these uses of it are deleted with it:`;
    return commands([{ op: 'removeInterface', interfaceId }], `Delete ${name} everywhere in the model`,
      `Deleted ${name} everywhere in the model.`, { elementId: scopeId(context) }, {
        title: `Delete ${name}?`, lead, message: lead, details: dependents.map((dependent) => dependent.label),
        confirmLabel: 'Delete', cancelLabel: 'Cancel',
      });
  }

  function planRemoveSelection(operation, context) {
    const elements = operation.elements || [];
    const relations = operation.relations || [];
    const count = elements.length + relations.length + (operation.fragments || []).length + (operation.activations || []).length;
    if (count !== 1) return refuseWith(ONE_AT_A_TIME);
    if (elements.length === 1) return planRemoveElement(elements[0] && typeof elements[0] === 'object' ? elements[0].id : elements[0], context);
    return planRemoveUses([lineOf(relations[0], context)], context);
  }

  /**
   * Deletes the uses `lines` stand for (`{ interfaceId, consumerId }` each: a drawn line, or a socket's use): one
   * `setUses` without the interface on every relationship behind each, after a confirmation that lists those
   * relationships. The relationships stay.
   */
  function planRemoveUses(lines, context) {
    const { shared } = siblings();
    const changes = new Map();
    lines.forEach((line) => relationshipsBehind(line, context).forEach((relationship) => {
      const kept = changes.has(relationship.id) ? changes.get(relationship.id).uses : writtenUses(relationship);
      changes.set(relationship.id, { relationship, uses: kept.filter((text) => !namesInterface(text, line.interfaceId)) });
    }));
    const [line] = lines;
    const phrase = `the use of ${interfaceName(context, line.interfaceId)} by ${nameOf(context, line.consumerId)}`;
    const related = [...changes.values()];
    const lead = related.length === 1
      ? `${capitalized(phrase)} is written on this relationship, which stays in the model:`
      : `${capitalized(phrase)} is written on these relationships, which stay in the model:`;
    return commands(related.map(({ relationship, uses }) => ({ op: 'setUses', relationshipId: relationship.id, uses })),
      `Delete ${phrase} everywhere in the model`,
      `Deleted ${phrase} everywhere in the model; ${related.length === 1 ? 'the relationship stays' : 'the relationships stay'}.`,
      { elementId: line.consumerId }, {
        title: `Delete ${phrase}?`, lead, message: lead,
        details: related.map(({ relationship }) => shared.sentence(nameOf(context, relationship.sourceId), relationship.description,
          nameOf(context, relationship.targetId), null)),
        confirmLabel: 'Delete', cancelLabel: 'Cancel',
      });
  }

  /** Whether a `uses` entry (`<interface>` or `<interface>.<operation>`) names `interfaceId`. */
  function namesInterface(text, interfaceId) {
    return text === interfaceId || text.startsWith(`${interfaceId}.`);
  }

  function capitalized(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /**
   * Draws a use from a box to a ball: `setUses` on a relationship from the consumer that may use the interface, or,
   * without one, the relationship form, which adds the relationship and the use in one batch (spec §5.5).
   */
  function planRelationAdd(operation, context) {
    if (operation.tool !== 'use') return addElementRefusal(context);
    if (!BOX.test(operation.from) || !BALL.test(operation.to)) return assemblyEnds();
    const consumer = boxOf(operation.from, context);
    const ball = portOf(operation.to, context);
    if (consumer.id === ball.elementId) return assemblyEnds();
    if (drawn(context).lines.some((line) => line.consumerId === consumer.id && line.interfaceId === ball.interfaceId)) return assemblyEnds();
    const { C4 } = siblings();
    const usable = (relationship) => C4.usableInterfaces(context.design, { sourceId: consumer.id, targetId: relationship.targetId })
      .some((candidate) => candidate.interfaceId === ball.interfaceId);
    const from = model(context).relationships.filter((relationship) => relationship.sourceId === consumer.id && usable(relationship));
    const declared = model(context).interfaces.get(ball.interfaceId);
    const relationship = from.find((candidate) => candidate.targetId === ball.elementId || candidate.targetId === declared.providerId) || from[0];
    if (relationship) return useOn(relationship, ball, context);
    return useThroughForm(consumer, ball, context);
  }

  function useOn(relationship, ball, context) {
    const [consumer, name] = [nameOf(context, relationship.sourceId), interfaceName(context, ball.interfaceId)];
    const target = nameOf(context, relationship.targetId);
    return commands([{ op: 'setUses', relationshipId: relationship.id, uses: writtenUses(relationship).concat(ball.interfaceId) }],
      `Use ${name} from ${consumer} everywhere in the model`,
      `${consumer} uses ${name} now: the use is added to the relationship from ${consumer} to ${target} in the model.`,
      { relationshipId: relationship.id });
  }

  /**
   * The relationship form from the consumer to the ball's provider box, which also writes the use. Its dry run of the
   * pair (with a placeholder description) gives the relationship's id, and a refusal of the core (an in-process
   * interface across a container boundary, a provider the use may not reach) is passed on before the form opens.
   */
  function useThroughForm(consumer, ball, context) {
    const { C4 } = siblings();
    const add = { op: 'addRelationship', sourceId: consumer.id, targetId: ball.elementId, description: 'uses' };
    const added = C4.edit(context.design, add);
    const relationshipId = added.error ? `${consumer.id}->${ball.elementId}` : added.selection.relationshipId;
    const use = { op: 'setUses', relationshipId, uses: [ball.interfaceId] };
    const dryRun = C4.edit(context.design, { op: 'batch', commands: [add, use] });
    if (dryRun.error) return { kind: 'refuse', code: dryRun.error, values: {}, offer: null, summary: null, message: dryRun.message };
    const [consumerName, providerName, name] = [nameOf(context, consumer.id), nameOf(context, ball.elementId), interfaceName(context, ball.interfaceId)];
    const lead = `To use ${name}, ${consumerName} needs a relationship to ${providerName}. This form adds that relationship to the model, with the use.`;
    return { kind: 'action', action: 'openRelationshipForm', args: [{ sourceId: consumer.id, targetId: ball.elementId }, { lead, alsoDispatch: [use] }],
      label: `Use ${name} from ${consumerName}` };
  }

  /** The label of a line lists the operations its consumer uses: they are edited under Uses in the relationship. */
  function planRelationUpdate(operation, context) {
    return refuse('derived/assembly-label', { Consumer: nameOf(context, lineOf(operation.ref, context).consumerId) });
  }

  /** The provider keeps the ball: a line is not turned around. */
  function planInvert(operation, context) {
    const line = lineOf(operation.ref, context);
    return refuse('interfaces/assembly-direction', {
      Interface: interfaceName(context, line.interfaceId), Consumer: nameOf(context, line.consumerId), Provider: nameOf(context, line.providerId),
    });
  }

  function planLayoutSet(operation, context) {
    return siblings().layout.planMove({ positions: operation.positions, routes: operation.routes, facts: operation.facts || {} }, context, view);
  }

  function planLayoutReset(operation, context) {
    const target = operation.target;
    const ref = target && target.route ? target.route : target && target.element;
    const refused = ref ? layoutRefusal(ref, context) : null;
    return refused ? refuse(refused.code, refused.values) : siblings().layout.planReset(target, context);
  }

  const PLANNERS = {
    'element.add': planAdd,
    'element.rename': planRename,
    'element.duplicate': () => refuse('not-in-model/duplicate'),
    'element.remove': (operation, context) => planRemoveElement(operation.ref, context),
    'selection.remove': planRemoveSelection,
    'relation.add': planRelationAdd,
    'relation.update': planRelationUpdate,
    'relation.rewire': () => assemblyEnds(),
    'relation.invert': planInvert,
    'layout.set': planLayoutSet,
    'layout.reset': planLayoutReset,
  };

  /** What `operation` means in this interfaces view: a plan for the C4 model adapter (plan Task 34). */
  function plan(operation, context) {
    const planner = PLANNERS[operation.op];
    if (!planner) throw new TypeError(`An interfaces view plans no ${operation.op}`);
    return planner(operation, context);
  }

  /**
   * Advice for a use being drawn (`request.open` is 'from' or 'to'): a use starts at a box and ends at a ball, so the
   * candidates of the open end are the boxes or the balls, each with the refusal its plan gives (spec §3.4
   * `targets`). Null for any other open end.
   */
  function targets(request, context) {
    if (!OPEN_ENDS.includes(request.open)) return null;
    const reading = drawn(context);
    const candidates = request.open === 'to' ? reading.ports.filter((port) => port.kind === 'ball') : reading.boxes;
    return candidates.map(({ alias }) => {
      const planned = plan(Object.assign({}, request, { tool: request.tool || 'use', [request.open]: alias }), context);
      const refused = planned.kind === 'refuse';
      return { ref: alias, ok: !refused, code: refused ? planned.code : null, values: refused ? planned.values : undefined,
        summary: refused && planned.summary !== undefined ? planned.summary : undefined };
    });
  }

  // ---- What the view offers (spec §7.3, §5.6) -------------------------------------------------------------

  /** The palette: Provided interface and Use an interface; Component, Port, and Note as unavailable. */
  function tools(context) {
    return {
      elements: ELEMENT_TOOLS.map((tool) => Object.assign({}, tool)),
      relations: RELATION_TOOLS.map((tool) => Object.assign({}, tool)),
      unavailable: UNAVAILABLE_TOOLS.map((tool) => Object.assign({}, tool,
        { values: tool.code === 'interfaces/add-element' ? { Scope: nameOf(context, scopeId(context)) } : {} })),
    };
  }

  /**
   * The option sets of the listbox: today's three sets of boxes ("Using what ‹subject› provides", "Subject of this
   * view", "Providing what ‹subject› requires"), then "Interfaces" (the balls, each "provided by ‹element›") and "Uses"
   * (the lines, each with the operations its consumer uses). A set the drawing leaves empty is left out.
   */
  function optionSets(context) {
    const reading = drawn(context);
    const components = context.viewModel.uml.components;
    const subject = components.find((component) => component.role === 'scope');
    const subjectName = subject ? subject.name : context.viewModel.title;
    const kept = context.layout ? context.layout.positions : new Map();
    const boxSets = BOX_SETS.map((set) => ({
      id: set.id,
      label: set.label(subjectName),
      options: components.filter((component) => component.role === set.role).map((component) => {
        const box = reading.boxes.find((candidate) => candidate.id === component.id);
        return box ? {
          ref: box.alias, name: component.name,
          description: [component.typeLabel, component.role === 'scope' ? 'subject of this view' : 'Enter shows its interfaces']
            .concat(kept.has(component.id) ? ['position kept'] : []).join('; '),
        } : null;
      }).filter(Boolean),
    }));
    const interfaces = { id: 'interfaces', label: 'Interfaces', options: reading.ports.filter((port) => port.kind === 'ball').map((ball) => ({
      ref: ball.alias, name: interfaceName(context, ball.interfaceId), description: ballDescription(ball, context),
    })) };
    const uses = { id: 'uses', label: 'Uses', options: reading.lines.map((line) => ({
      ref: line.ref, name: `${nameOf(context, line.consumerId)} uses ${interfaceName(context, line.interfaceId)}`, description: useDescription(line, context),
    })) };
    return boxSets.concat([interfaces, uses]).filter((set) => set.options.length > 0);
  }

  /** "provided by ‹element›", and who uses it through this ball, or that nothing does. */
  function ballDescription(ball, context) {
    const declared = model(context).interfaces.get(ball.interfaceId);
    const words = [`provided by ${nameOf(context, ball.elementId)}`];
    if (declared && declared.providerId !== ball.elementId) words.push(`declared on ${nameOf(context, declared.providerId)}`);
    words.push(ball.consumerId === null ? 'nothing here uses it' : `used by ${nameOf(context, ball.consumerId)}`);
    return words.join('; ');
  }

  /** The operations the consumer of `line` uses, by the uses entries of the relationships behind it. */
  function useDescription(line, context) {
    const declared = model(context).interfaces.get(line.interfaceId);
    const operationIds = [...new Set(relationshipsBehind(line, context)
      .flatMap((relationship) => relationship.uses.filter((use) => use.interfaceId === line.interfaceId).map((use) => use.operationId)))];
    if (operationIds.length === 0 || operationIds.includes(null)) return `provided by ${nameOf(context, line.providerId)}; uses the whole interface`;
    const named = operationIds.map((id) => {
      const operation = declared ? declared.operations.find((candidate) => candidate.id === id) : null;
      return operation && operation.syntax ? `${id} (${operation.syntax})` : id;
    });
    return `provided by ${nameOf(context, line.providerId)}; ${named.length === 1 ? 'operation' : 'operations'} used: ${named.join(', ')}`;
  }

  /** Every drawn box can hold a position: the consumers, the subject, and the providers (spec §4.2, §14 D3). */
  function holders(context) {
    return new Set(drawn(context).boxes.map((box) => box.alias));
  }

  /**
   * Why `ref` holds no layout, `{ code, values }`, or null for a box: a ball or socket is placed on the side of its box
   * that faces its partner, and the line between them is routed for you (spec §4.2). A line is named by its option
   * (`rel:<n>`) or by the renderer's route id of either of its two parts (`edge-<n>`).
   */
  function layoutRefusal(ref, context) {
    if (typeof ref === 'string' && BOX.test(ref) && Object.prototype.hasOwnProperty.call(context.uml.ids, ref)) return null;
    if (typeof ref === 'string' && (BALL.test(ref) || SOCKET.test(ref))) return { code: 'layout/port', values: {} };
    return { code: 'layout/assembly', values: {} };
  }

  /**
   * The selection an option stands for: a box's element, a ball's interface, a line's first relationship behind it.
   * Null for anything else, a socket among them: only an option selects, so a press on a socket (which has no option;
   * its use is the line's) changes no selection the listbox could not show.
   */
  function selectionOf(ref, context) {
    if (typeof ref !== 'string') return null;
    const reading = drawn(context);
    const box = reading.boxes.find((candidate) => candidate.alias === ref);
    if (box) return { elementId: box.id };
    const ball = reading.ports.find((candidate) => candidate.alias === ref && candidate.kind === 'ball');
    if (ball) return { interfaceId: ball.interfaceId };
    const line = LINE_REF.test(ref) ? reading.lines.find((candidate) => candidate.ref === ref) : null;
    const behind = line ? relationshipsBehind(line, context) : [];
    return behind.length > 0 ? { relationshipId: behind[0].id } : null;
  }

  /** The option a selection from the outline or a form stands for (a box, the first ball of an interface, a line), or null. */
  function refOf(selection, context) {
    if (!selection) return null;
    const reading = drawn(context);
    if (selection.relationshipId) {
      const line = reading.lines.find((candidate) => relationshipsBehind(candidate, context).some((each) => each.id === selection.relationshipId));
      return line ? line.ref : null;
    }
    if (selection.interfaceId) {
      const ball = reading.ports.find((port) => port.kind === 'ball' && port.interfaceId === selection.interfaceId);
      return ball ? ball.alias : null;
    }
    const box = selection.elementId ? reading.boxes.find((candidate) => candidate.id === selection.elementId) : null;
    return box ? box.alias : null;
  }

  const view = { notation: NOTATION, editable: true, optionSets, tools, plan, targets, holders, layoutRefusal, selectionOf, refOf };
  return view;
});
