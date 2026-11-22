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

  // The view module of dynamic views, `dynamic ‹scenario›`, drawn as UML sequence diagrams (UML-view editing spec §5.3,
  // §7.3, §7.4; plan Task 44). It tells the canvas what a dynamic view offers (option sets, tools, the places a step can
  // go) and plans what each operation of the diagram editor means in design.yml. It decides nothing the C4 core decides:
  // which ends a step may have at a place is `ArchUMLC4.stepEnds` (the rule the scenario form follows too), and the C4
  // model adapter (c4-editor-uml-adapter.js) runs a plan's commands as one batch after a dry run and the lock check,
  // calls the shared action a plan names, opens the anchored form a plan names, and words every refusal by the refusal
  // table. Siblings are read at call time (the core, the shared action helpers, the layout planner, the refusal table),
  // so this file loads in any order.
  //
  // Every member takes the canvas's `context` (plan Task 34): `{ design, viewModel, uml, profile, checksReleased,
  // revision, layout }`. A lifeline is named by its alias in the drawing (`uml.ids` maps it to its element); an end of a
  // step may also be named by an element id the drawing has no lifeline for yet ("Another element…", spec §5.3). A
  // message is named by `seqmsg:<n>` and a fragment by `frag:<n>`, the line of the drawn text (without its layout
  // block) that the source map (spec §4.1) gives its step position `{ containerPath, index }`. An insertion place `at`
  // is an anchor `{ beforeLine }` of the drawing (spec §3.4), or a step position; none means the end of the scenario.
  //
  // The anchored forms (plan Task 45 builds them; `fromForm` reads their answer). Each form resolves its `initial`
  // with the learner's choices written over it (`Object.assign({}, initial, choices)`), or null for Escape:
  // - `step`: `{ mode: 'add' | 'edit', scenarioId, step (edit: its position), from, to, senders: [{ id, name }],
  //   receivers: { <sender id>: [{ id, name }] }, position, at, places: [{ at, position, label, current }],
  //   description, connector }`. The learner may change `from`, `to`, `at` (one of `places`), `description`, and
  //   `connector.value` (or `connector` itself, a connector id or null). `connector` is null where the step runs along
  //   no relationship (a reply, a delivery), else `{ relationshipId, followed, label, value, options: [{ value, label }],
  //   warnings: { <connector>: sentence }, warning }`: `value` null follows the relationship ("Follows the
  //   relationship: call"); another value carries `warnings[value]`, and the form's button opens `relationshipId`.
  // - `fragment`: `{ mode: 'add' | 'wrap', scenarioId, operator, operators, guard, position, at, places }`, and for a
  //   wrap `first` (the first step's position), `lastChoices: [{ index, label }]`, and `last` (an index of that list).

  const NOTATION = 'uml-sequence';
  // The five fragments of this design model's scenarios (C4 spec §4.8); alt and par hold a list of branches.
  const FRAGMENT_OPERATORS = ['alt', 'opt', 'loop', 'par', 'break'];
  const MULTI_BRANCH = ['alt', 'par'];
  // The connectors of a relationship or a step (c4-schema.js CONNECTORS), and those that do not wait for an answer.
  const CONNECTORS = ['call', 'message', 'event', 'stream', 'shared-data'];
  const ASYNC_CONNECTORS = ['message', 'event', 'stream'];
  const CONNECTOR_NOUNS = { call: 'a call', message: 'a message', event: 'an event', stream: 'a stream', 'shared-data': 'shared data' };
  // The palette (spec §5.3, §7.6): one Message tool, since the arrow a message gets is derived, and the five fragments.
  const MESSAGE_TOOL = { id: 'message', label: 'Message', glyph: '→' };
  const FRAGMENT_TOOL = { id: 'fragment', label: 'Fragment', glyph: '▭', operators: FRAGMENT_OPERATORS.slice() };
  const UNAVAILABLE_TOOLS = [
    { id: 'critical', label: 'critical', code: 'not-in-model/fragment' },
    { id: 'ref', label: 'ref', code: 'not-in-model/fragment' },
    { id: 'neg', label: 'neg', code: 'not-in-model/fragment' },
    { id: 'activation', label: 'Activation bar', code: 'not-in-model/sequence-detail' },
    { id: 'create', label: 'Create message', code: 'not-in-model/sequence-detail' },
    { id: 'destroy', label: 'Destroy mark', code: 'not-in-model/sequence-detail' },
    { id: 'lost', label: 'Lost message', code: 'not-in-model/sequence-detail' },
    { id: 'found', label: 'Found message', code: 'not-in-model/sequence-detail' },
    { id: 'note', label: 'Note', code: 'not-in-model/note' },
  ].map((tool) => Object.assign(tool, { values: {} }));
  const UNAVAILABLE_BY_ID = new Map(UNAVAILABLE_TOOLS.map((tool) => [tool.id, tool]));
  const LIFELINE_TOOLS = new Set(['actor', 'participant', 'lifeline', 'boundary', 'control', 'entity', 'database']);
  // The words a step option uses for what its arrow shows (projection statuses, C4 spec §6.3).
  const STATUS_WORDS = { forward: 'call', async: 'asynchronous message', reply: 'reply', delivery: 'delivery', invalid: 'invalid step' };
  const MESSAGE_REF = /^seqmsg:(\d+)$/;
  const FRAGMENT_REF = /^frag:(\d+)$/;
  const OPEN_ENDS = ['from', 'to'];
  // A refusal the table has no row for: a view deletes one drawn thing at a time (the C4 surface selects one).
  const ONE_AT_A_TIME = { code: 'one-at-a-time', summary: 'Delete one thing at a time',
    message: 'Select one lifeline, step, or fragment and delete it; this view deletes one thing at a time.' };
  const NO_POSITIONS = { code: 'layout/sequence-order', summary: 'Placed in reading order',
    message: 'A sequence diagram has no free positions. Move a lifeline sideways to change their order, or move a step up or down.' };
  const NO_ENDS = { code: 'step/no-ends', summary: 'Choose both ends', message: 'Choose the sender and the receiver of the step.' };

  // ---- Reading the drawing and the scenario ---------------------------------------------------------------

  function model(context) {
    return context.design.model;
  }

  function scenarioId(context) {
    return context.viewModel.scopeId;
  }

  function scenario(context) {
    return model(context).scenarios.get(scenarioId(context));
  }

  function nameOf(context, id) {
    return siblings().shared.elementName(model(context), id);
  }

  function aliasOf(id, context) {
    return Object.keys(context.uml.ids).find((alias) => context.uml.ids[alias] === id) || null;
  }

  /** The element an end names: a lifeline's alias, or the id of an element the drawing has no lifeline for; null for none. */
  function endId(ref, context) {
    if (ref === null || ref === undefined) return null;
    if (Object.prototype.hasOwnProperty.call(context.uml.ids, ref)) return context.uml.ids[ref];
    if (model(context).elements.has(ref)) return ref;
    throw new TypeError(`The dynamic view has no lifeline or element ${JSON.stringify(ref)}`);
  }

  /** The element whose organization box `ref` names (`box:<id>`, or the id of a drawn box), or null. */
  function boxOf(ref, context) {
    const id = typeof ref === 'string' && ref.startsWith('box:') ? ref.slice(4) : ref;
    return context.uml.source.lines.some((entry) => entry && entry.kind === 'box' && entry.id === id) ? id : null;
  }

  function entries(context, kind) {
    return context.uml.source.lines.map((entry, line) => (entry && entry.kind === kind ? Object.assign({ line }, entry) : null)).filter(Boolean);
  }

  function lineIndex(ref, pattern) {
    if (typeof ref === 'string' && pattern.test(ref)) return Number(pattern.exec(ref)[1]);
    if (ref && typeof ref === 'object' && typeof ref.routeId === 'string' && pattern.test(ref.routeId)) return lineIndex(ref.routeId, pattern);
    if (ref && Number.isInteger(ref.line) && ref.line >= 0) return ref.line;
    if (ref && Array.isArray(ref.candidates) && ref.candidates.length === 1) return lineIndex(ref.candidates[0], pattern);
    if (Number.isInteger(ref) && ref >= 0) return ref;
    throw new TypeError(`A dynamic view cannot resolve ${JSON.stringify(ref)} to one drawn line`);
  }

  /** The drawn message `ref` names: `{ line, containerPath, index, status, step }` (`step`, the model's). */
  function messageOf(ref, context) {
    const line = lineIndex(ref, MESSAGE_REF);
    const entry = context.uml.source.lines[line];
    if (!entry || entry.kind !== 'message') throw new TypeError(`Line ${line} of the dynamic view is no message`);
    const position = positionCopy(entry);
    return Object.assign({ line, status: entry.status, step: itemAt(context, position) }, position);
  }

  /** The drawn fragment `ref` names: `{ line, containerPath, index, operator, fragment }` (`fragment`, the model's). */
  function fragmentOf(ref, context) {
    const line = lineIndex(ref, FRAGMENT_REF);
    const entry = context.uml.source.lines[line];
    if (!entry || entry.kind !== 'fragment') throw new TypeError(`Line ${line} of the dynamic view is no fragment`);
    const position = positionCopy(entry);
    return Object.assign({ line, operator: entry.operator, fragment: itemAt(context, position) }, position);
  }

  function isMessageRef(ref) {
    return (typeof ref === 'string' && MESSAGE_REF.test(ref)) || Boolean(ref && typeof ref === 'object' && !FRAGMENT_REF.test(String(ref.routeId)));
  }

  function positionCopy(entry) {
    return { containerPath: entry.containerPath.slice(), index: entry.index };
  }

  const samePosition = (a, b) => a.index === b.index && sameList(a.containerPath, b.containerPath);
  const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const startsWith = (path, prefix) => prefix.every((part, at) => path[at] === part);

  /**
   * The fragments a step list's `containerPath` goes through, outermost first (C4 spec §4.8: `[2, 'alt', 0]`,
   * `[1, 'opt']`, `[2, 'alt', 0, 'steps', 1, 'opt']`), each `{ fragment, operator, branch, list }` with the list it holds.
   */
  function segmentsOf(steps, containerPath) {
    const segments = [];
    let list = steps;
    let at = 0;
    while (at < containerPath.length) {
      const fragment = list[containerPath[at]];
      const operator = containerPath[at + 1];
      const branch = MULTI_BRANCH.includes(operator) ? containerPath[at + 2] : 0;
      list = fragment.branches[branch].steps;
      segments.push({ fragment, operator, branch, list });
      at += MULTI_BRANCH.includes(operator) ? 3 : 2;
      if (containerPath[at] === 'steps') at += 1;
    }
    return segments;
  }

  /** The step list `containerPath` names in a step tree: the model's steps, or `classifySteps`, which mirrors them. */
  function listAt(steps, containerPath) {
    const segments = segmentsOf(steps, containerPath);
    return segments.length > 0 ? segments[segments.length - 1].list : steps;
  }

  function itemAt(context, position) {
    return listAt(scenario(context).steps, position.containerPath)[position.index] || null;
  }

  /** The container path of branch `branch` of the fragment at `position`. */
  function branchPath(position, operator, branch) {
    const prefix = position.containerPath.length > 0 ? position.containerPath.concat('steps') : [];
    return prefix.concat(position.index, operator, MULTI_BRANCH.includes(operator) ? [branch] : []);
  }

  /** Every message step of the scenario, drawn or not, in reading order: `{ containerPath, index, step }`. */
  function messageSteps(steps, containerPath = []) {
    return steps.flatMap((step, index) => {
      if (step.kind !== 'fragment') return [{ containerPath, index, step }];
      return step.branches.flatMap((branch, number) => messageSteps(branch.steps, branchPath({ containerPath, index }, step.operator, number)));
    });
  }

  /** The step number of each drawn message (1 for the first in reading order), by its position. */
  function numbering(context) {
    const numbers = new Map();
    entries(context, 'message').forEach((entry, at) => numbers.set(positionKey(entry), at + 1));
    return numbers;
  }

  const positionKey = (position) => `${JSON.stringify(position.containerPath)}#${position.index}`;

  /** "step 3" for a drawn message, "the alt" for a fragment, at `position`. */
  function itemName(context, position, numbers = numbering(context)) {
    const item = itemAt(context, position);
    if (item && item.kind === 'fragment') return `the ${item.operator}`;
    return numbers.has(positionKey(position)) ? `step ${numbers.get(positionKey(position))}` : 'a step this view does not draw';
  }

  /** "in alt, branch 2: not eligible", "in loop: each section": the innermost fragment branch of a step list; null at the top. */
  function containerPhrase(context, containerPath) {
    const segments = segmentsOf(scenario(context).steps, containerPath);
    if (segments.length === 0) return null;
    const { fragment, operator, branch } = segments[segments.length - 1];
    const guard = fragment.branches[branch].when;
    const where = MULTI_BRANCH.includes(operator) ? `in ${operator}, branch ${branch + 1}` : `in ${operator}`;
    return guard ? `${where}: ${guard}` : where;
  }

  /** "one step", "3 steps". */
  const countOf = (count, noun) => (count === 1 ? `one ${noun}` : `${count} ${noun}s`);
  const upperFirst = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);

  /** The label of an insertion place ("Before step 5, in alt, branch 2: not eligible", spec §7.4). */
  function placeLabel(context, position, numbers) {
    const where = containerPhrase(context, position.containerPath);
    if (itemAt(context, position)) {
      const before = `Before ${itemName(context, position, numbers)}`;
      return where ? `${before}, ${where}` : before;
    }
    return where ? `${upperFirst(where)}, at the end` : 'At the end of the scenario';
  }

  /** Every insertion place of the drawing in reading order, each once: `{ at: { beforeLine }, position, label }`. */
  function allPlaces(context) {
    const { C4 } = siblings();
    const numbers = numbering(context);
    const seen = new Set();
    const places = [];
    context.uml.source.lines.forEach((entry, line) => {
      const position = C4.positionForAnchor(context.uml.source, line);
      if (!position || seen.has(positionKey(position))) return;
      seen.add(positionKey(position));
      places.push({ at: { beforeLine: line }, position, label: placeLabel(context, position, numbers) });
    });
    return places;
  }

  /** The step position an insertion place `at` names: an anchor, a position, or none for the end of the scenario. */
  function positionOf(at, context) {
    if (at === null || at === undefined) return positionCopy(context.uml.source.scenarioEnd);
    if (Array.isArray(at.containerPath) && Number.isInteger(at.index)) return positionCopy(at);
    const position = Number.isInteger(at.beforeLine) ? siblings().C4.positionForAnchor(context.uml.source, at.beforeLine) : null;
    if (!position) throw new TypeError(`${JSON.stringify(at)} is no insertion place of the dynamic view`);
    return position;
  }

  /** The place of `position` among `places`, so a form's Position select starts on it; else the position itself. */
  function atOf(position, places) {
    const place = places.find((candidate) => samePosition(candidate.position, position));
    return place ? place.at : positionCopy(position);
  }

  // ---- Refusals and plans ---------------------------------------------------------------------------------

  function refuse(code, values = {}, offer = null) {
    return { kind: 'refuse', code, values, offer };
  }

  /** A refusal the table has no row for, with its own words. */
  function refuseWith(words) {
    return { kind: 'refuse', code: words.code, values: {}, offer: null, summary: words.summary, message: words.message };
  }

  /** Nothing to change (a move to where the thing is, a form that changes nothing): no message, nothing written. */
  function nothingToDo() {
    return refuse('cancelled');
  }

  function commands(list, label, message, select = null, extra = {}) {
    return Object.assign({ kind: 'commands', commands: list, label, select, message, confirm: null }, extra);
  }

  function stepSelection(context, position) {
    return { scenarioId: scenarioId(context), step: positionCopy(position) };
  }

  function isInside(context, id, ancestorId) {
    const elements = model(context).elements;
    for (let current = elements.get(id); current && current.parentId; current = elements.get(current.parentId)) {
      if (current.parentId === ancestorId) return true;
    }
    return false;
  }

  /**
   * Why a step from `from` to `to` cannot stand at `position` (in place of the step there with `replace`), as a
   * refusal with the values its sentence is filled from and the table's offer made runnable; null when it can.
   */
  function stepRefusal(context, from, to, position, { replace = false } = {}) {
    const { C4 } = siblings();
    const problem = C4.stepEnds(context.design, { scenarioId: scenarioId(context), containerPath: position.containerPath,
      index: position.index, replace }).problemOf(from, to);
    if (!problem) return null;
    const values = { Sender: nameOf(context, from), Receiver: nameOf(context, to) };
    if (problem === 'nested-ends') {
      const [child, parent] = isInside(context, from, to) ? [from, to] : [to, from];
      Object.assign(values, { Child: nameOf(context, child), Parent: nameOf(context, parent) });
    }
    if (problem === 'same-element') values.Name = nameOf(context, from);
    const code = problem === 'unknown-element' ? 'step/not-available' : `step/${problem}`;
    return refuse(code, values, runnableOffer(context, code, values, { from, to, position }));
  }

  /**
   * The table's offer for a step refusal (none for the novice profile and while checks are withheld), with the
   * operation that accepting it applies: the request's step form for a reply without one, the relationship form for a
   * declared relationship (spec §5.3).
   */
  function runnableOffer(context, code, values, { from, to, position }) {
    const offer = siblings().refusals.verdict(code, values, { checksReleased: context.checksReleased, profile: context.profile }).offer;
    if (!offer) return null;
    const message = (fields) => Object.assign({ op: 'relation.add', tool: MESSAGE_TOOL.id, label: null, at: positionCopy(position) }, fields);
    if (offer.kind === 'add-request') return Object.assign({}, offer, { operation: message({ from: to, to: from }) });
    if (offer.kind === 'declare-relationship') return Object.assign({}, offer, { operation: message({ from, to, declare: true }) });
    return offer;
  }

  // ---- Steps: drawing, the step form, and the relationship a step runs along ------------------------------

  /** The classification of a step from `from` to `to` added at `position` (`{ status, relationshipIds }`), or null. */
  function trialClassification(context, from, to, position) {
    const { C4 } = siblings();
    const add = { op: 'addStep', scenarioId: scenarioId(context), containerPath: position.containerPath, index: position.index, step: { from, to } };
    const result = C4.edit(context.design, add);
    if (result.error) return null;
    return listAt(C4.classifySteps(C4.load(result.text), scenarioId(context)), position.containerPath)[position.index] || null;
  }

  function classificationAt(context, position) {
    return listAt(siblings().C4.classifySteps(context.design, scenarioId(context)), position.containerPath)[position.index] || null;
  }

  function relationshipOf(context, classified) {
    const id = classified && ['forward', 'async'].includes(classified.status) ? (classified.relationshipIds || [])[0] : null;
    return id ? model(context).relationships.find((candidate) => candidate.id === id) || null : null;
  }

  /**
   * The description a new step starts with (spec §5.3): for a step along a relationship, the words this scenario
   * already gives a step between the same two elements, else the relationship's description; empty for a reply or a
   * delivery, which answer an earlier request.
   */
  function startingDescription(context, from, to, classified) {
    const relationship = relationshipOf(context, classified);
    if (!relationship) return '';
    const earlier = messageSteps(scenario(context).steps).find(({ step }) => step.from === from && step.to === to && step.description);
    return earlier ? earlier.step.description : relationship.description || '';
  }

  /** The words of a step's connector against its relationship's: "asynchronous" across the two kinds, else its noun. */
  function connectorWords(chosen, followed) {
    return ASYNC_CONNECTORS.includes(chosen) && !ASYNC_CONNECTORS.includes(followed) ? 'asynchronous' : CONNECTOR_NOUNS[chosen];
  }

  /** The warning of a step whose connector differs from its relationship's (spec §5.3, "Make a message asynchronous"). */
  function connectorWarning(chosen, followed) {
    const words = connectorWords(chosen, followed);
    return `This step would be ${words}, while the relationship it runs along is ${CONNECTOR_NOUNS[followed]}. `
      + `A step usually follows its relationship; if every use is ${words}, change the relationship's connector.`;
  }

  /** The step form's connector field for a step along `relationship`, with `value` chosen (null: it follows); or null. */
  function connectorField(relationship, value) {
    if (!relationship) return null;
    const followed = relationship.connector || 'call';
    const warnings = {};
    CONNECTORS.filter((connector) => connector !== followed).forEach((connector) => { warnings[connector] = connectorWarning(connector, followed); });
    const chosen = value === undefined ? null : value;
    return {
      relationshipId: relationship.id, followed, label: `Follows the relationship: ${followed}`, value: chosen,
      options: [{ value: null, label: `Follows the relationship: ${followed}` }]
        .concat(CONNECTORS.map((connector) => ({ value: connector, label: connector }))),
      warnings, warning: chosen && chosen !== followed ? warnings[chosen] : null,
    };
  }

  function named(context, ids) {
    return ids.map((id) => ({ id, name: nameOf(context, id) }));
  }

  /** The ends a step may have at `position` (`stepEnds`): every allowed sender and, for each, its allowed receivers. */
  function endChoices(context, position, { replace = false, senders = null } = {}) {
    const { C4 } = siblings();
    const options = { scenarioId: scenarioId(context), containerPath: position.containerPath, index: position.index, replace };
    const ends = C4.stepEnds(context.design, options);
    const froms = senders || ends.froms;
    const receivers = {};
    froms.forEach((from) => {
      const tos = senders ? C4.stepEnds(context.design, Object.assign({ sender: from }, options)).tosOf(from) : ends.tosOf(from);
      receivers[from] = named(context, tos);
    });
    return { senders: named(context, froms), receivers };
  }

  /** The step form for a new step at `position` from `from` to `to` (either may still be open). */
  function addStepForm(context, from, to, position) {
    const places = allPlaces(context);
    const classified = from && to ? trialClassification(context, from, to, position) : null;
    const initial = Object.assign({ mode: 'add', scenarioId: scenarioId(context), from, to, position, at: atOf(position, places), places,
      description: from && to ? startingDescription(context, from, to, classified) : '',
      connector: connectorField(relationshipOf(context, classified), null) }, endChoices(context, position));
    return { kind: 'form', form: 'step', initial, label: 'Add a step' };
  }

  /** The step form of the drawn message `message`, with `changes` already chosen (a connector). */
  function editStepForm(context, message, changes = {}) {
    const ref = `seqmsg:${message.line}`;
    const places = placesFor(ref, context);
    const position = positionCopy(message);
    const connector = 'connector' in changes ? changes.connector : message.step.connector;
    const initial = Object.assign({ mode: 'edit', scenarioId: scenarioId(context), step: position, from: message.step.from, to: message.step.to,
      position, at: atOf(position, places), places, description: message.step.description || '',
      connector: connectorField(relationshipOf(context, classificationAt(context, position)), connector) },
    endChoices(context, position, { replace: true, senders: siblings().C4.structuralSenders(context.design) }));
    return { kind: 'form', form: 'step', initial, label: `Edit ${itemName(context, position)}` };
  }

  function addStepCommand(context, position, step) {
    return { op: 'addStep', scenarioId: scenarioId(context), containerPath: position.containerPath, index: position.index, step };
  }

  /** Draw a message (spec §5.3): refused by `stepEnds`, else the step form at its place; or, from the expert offer, the relationship form. */
  function planMessage(context, fromRef, toRef, at, { declare = false } = {}) {
    const from = endId(fromRef, context);
    const to = endId(toRef, context);
    const position = positionOf(at, context);
    if (!from || !to) return addStepForm(context, from, to, position);
    const refusal = stepRefusal(context, from, to, position);
    // The expert offer's operation: the relationship form, but only while the refusal still offers it.
    const declared = declare && refusal && refusal.offer && refusal.offer.kind === 'declare-relationship';
    if (declared) return planDeclare(context, from, to, position);
    return refusal || addStepForm(context, from, to, position);
  }

  /** "Declare a relationship from ‹Sender› to ‹Receiver›…": the relationship form, whose batch also adds the step (spec §5.3). */
  function planDeclare(context, from, to, position) {
    const lead = `This adds a relationship to the model. ${nameOf(context, from)} will depend on ${nameOf(context, to)} in every scenario `
      + 'and every view, not only in this one. Is that the design you want?';
    return { kind: 'action', action: 'openRelationshipForm', label: `Declare a relationship from ${nameOf(context, from)}`,
      args: [{ sourceId: from, targetId: to }, { lead, alsoDispatch: [addStepCommand(context, position, { from, to })] }] };
  }

  function planRelationAdd(operation, context) {
    const unavailable = UNAVAILABLE_BY_ID.get(operation.tool);
    if (unavailable) return refuse(unavailable.code);
    // A drag gives the place it ended at as the scene fact `at` (spec §3.4); a click path and a menu give `at` itself.
    const at = operation.at || (operation.facts && operation.facts.at) || null;
    return planMessage(context, operation.from, operation.to, at, { declare: operation.declare === true });
  }

  /** A step's ends written as they read: `{ from }`, `{ to }`, or both, after the same check as drawing it there. */
  function planEnds(context, message, from, to, label) {
    const refusal = stepRefusal(context, from, to, message, { replace: true });
    if (refusal) return refusal;
    const changes = {};
    if (from !== message.step.from) changes.from = from;
    if (to !== message.step.to) changes.to = to;
    if (Object.keys(changes).length === 0) return nothingToDo();
    const name = itemName(context, message);
    return commands([{ op: 'updateStep', scenarioId: scenarioId(context), containerPath: message.containerPath, index: message.index, step: changes }],
      `${label} ${name}`, `${upperFirst(name)} now runs from ${nameOf(context, from)} to ${nameOf(context, to)}.`, stepSelection(context, message));
  }

  function planRewire(operation, context) {
    const message = messageOf(operation.ref, context);
    const to = endId(operation.to, context);
    return operation.end === 'source'
      ? planEnds(context, message, to, message.step.to, 'Move the sender of')
      : planEnds(context, message, message.step.from, to, 'Move the receiver of');
  }

  function planInvert(operation, context) {
    const message = messageOf(operation.ref, context);
    return planEnds(context, message, message.step.to, message.step.from, 'Turn around');
  }

  /**
   * Edits a message: its label is the step's description; its connector is chosen in the step form, which warns when
   * it leaves the relationship's; an empty change opens the step form. Its arrow is derived from the model.
   */
  function planRelationUpdate(operation, context) {
    const message = messageOf(operation.ref, context);
    const changes = operation.changes || {};
    if (typeof changes.label === 'string') {
      const name = itemName(context, message);
      return commands([{ op: 'updateStep', scenarioId: scenarioId(context), containerPath: message.containerPath, index: message.index,
        step: { description: changes.label.trim() } }], `Edit the description of ${name}`, `Changed the description of ${name}.`,
      stepSelection(context, message));
    }
    if ('connector' in changes || Object.keys(changes).length === 0) return editStepForm(context, message, changes);
    return refuse('derived/arrow');
  }

  /** The step form's answer: a new step (with the same check as drawing it), or the changes to an existing one. */
  function stepFromForm(values, context) {
    const from = values.from || null;
    const to = values.to || null;
    if (!from || !to) return refuseWith(NO_ENDS);
    const position = positionOf(values.at, context);
    const description = String(values.description || '').trim();
    const connector = values.connector && typeof values.connector === 'object' ? values.connector.value : values.connector || null;
    if (values.mode === 'edit') return editFromForm(context, values, { from, to, position, description, connector });
    const refusal = stepRefusal(context, from, to, position);
    if (refusal) return refusal;
    const step = Object.assign({ from, to, description }, connector ? { connector } : {});
    const place = lowerFirst(placeLabel(context, position, numbering(context)));
    return commands([addStepCommand(context, position, step)], `Add a step from ${nameOf(context, from)}`,
      `Added a step from ${nameOf(context, from)} to ${nameOf(context, to)}, ${place}.`, stepSelection(context, position));
  }

  function editFromForm(context, values, { from, to, position, description, connector }) {
    const at = positionCopy(values.step);
    const current = itemAt(context, at);
    const changes = {};
    if (from !== current.from) changes.from = from;
    if (to !== current.to) changes.to = to;
    if (description !== (current.description || '')) changes.description = description;
    if (connector !== (current.connector || null)) changes.connector = connector;
    if (changes.from || changes.to) {
      const refusal = stepRefusal(context, from, to, at, { replace: true });
      if (refusal) return refusal;
    }
    const list = Object.keys(changes).length > 0
      ? [{ op: 'updateStep', scenarioId: scenarioId(context), containerPath: at.containerPath, index: at.index, step: changes }] : [];
    // A Position the step already has (where it is, or the place right after it) moves nothing.
    const moved = moveCommand(context, Object.assign({ kind: 'message' }, at), position);
    const move = moved.kind === 'refuse' ? null : moved;
    const all = list.concat(move ? [move] : []);
    if (all.length === 0) return nothingToDo();
    const name = itemName(context, at);
    return commands(all, `Edit ${name}`, `Changed ${name}.`, move ? null : stepSelection(context, at));
  }

  // ---- Moving steps and fragments (spec §5.3, §7.4) --------------------------------------------------------

  /**
   * The `moveStep` that takes the item at `item` (a position, with `kind`) to the insertion place `target`, or a
   * refusal: nothing to do where it already is, `fragment-into-itself` into one of its own branches. Within its list,
   * `to` is the index after the move; across lists both name places in the document before the move (§4.3).
   */
  function moveCommand(context, item, target) {
    const base = { op: 'moveStep', scenarioId: scenarioId(context), containerPath: item.containerPath, from: item.index };
    if (sameList(item.containerPath, target.containerPath)) {
      if (target.index === item.index || target.index === item.index + 1) return nothingToDo();
      return Object.assign(base, { to: target.index > item.index ? target.index - 1 : target.index });
    }
    if (item.kind === 'fragment' && insideFragment(item, target.containerPath)) return refuse('fragment-into-itself');
    return Object.assign(base, { to: target.index, toContainerPath: target.containerPath });
  }

  /** Whether step-list path `path` lies inside one of the branches of the fragment at `item`. */
  function insideFragment(item, path) {
    const prefix = item.containerPath.length > 0 ? item.containerPath.concat('steps') : [];
    return startsWith(path, prefix.concat(item.index, item.operator));
  }

  /** The thing a move moves: a drawn message or fragment, as a position with its kind. */
  function movedItem(ref, context) {
    if (isMessageRef(ref)) return Object.assign({ kind: 'message' }, messageOf(ref, context));
    return Object.assign({ kind: 'fragment' }, fragmentOf(ref, context));
  }

  function planMove(operation, context) {
    const item = movedItem(operation.ref, context);
    let target;
    if (operation.at && Number.isInteger(operation.at.step)) {
      const places = placesFor(movedRef(item), context);
      const current = places.findIndex((place) => place.current);
      const next = places[current + operation.at.step];
      if (!next) return refuseWith({ code: 'no-place', summary: operation.at.step < 0 ? 'Already first' : 'Already last',
        message: `${upperFirst(itemName(context, item))} has no place ${operation.at.step < 0 ? 'before' : 'after'} where it is now.` });
      target = next.position;
    } else {
      target = positionOf(operation.at, context);
    }
    const move = moveCommand(context, item, target);
    if (move.kind === 'refuse') return move;
    const name = itemName(context, item);
    const dryRun = siblings().C4.edit(context.design, move);
    const select = dryRun.error ? null : stepSelection(context, { containerPath: dryRun.selection.containerPath, index: dryRun.selection.index });
    return commands([move], `Move ${name}`, `Moved ${name}; it is now ${lowerFirst(placeLabel(context, target, numbering(context)))}.`, select);
  }

  function movedRef(item) {
    return item.kind === 'fragment' ? `frag:${item.line}` : `seqmsg:${item.line}`;
  }

  /**
   * The insertion places for `ref` in reading order, entering and leaving branches (spec §7.4): for a drawn message or
   * fragment every place it can move to, with the one where it is now first in its turn (`current`, "Where it is now")
   * and without the place right after it, which is the same; a fragment does not offer its own branches. Without a ref,
   * every place a new step or fragment can go.
   */
  function placesFor(ref, context) {
    const all = allPlaces(context);
    if (ref === null || ref === undefined) return all;
    const item = movedItem(ref, context);
    const after = { containerPath: item.containerPath, index: item.index + 1 };
    return all.filter((place) => !samePosition(place.position, after) && !(item.kind === 'fragment' && insideFragment(item, place.position.containerPath)))
      .map((place) => (samePosition(place.position, item) ? Object.assign({}, place, { label: 'Where it is now', current: true }) : place));
  }

  // ---- Deleting (spec §5.3) --------------------------------------------------------------------------------

  function stepDetail(context, entry, numbers) {
    const ends = `${nameOf(context, entry.step.from)} to ${nameOf(context, entry.step.to)}`;
    const number = numbers.get(positionKey(entry));
    return number ? `Step ${number}: ${ends}` : ends;
  }

  function removeStepCommand(context, position) {
    return { op: 'removeStep', scenarioId: scenarioId(context), containerPath: position.containerPath, index: position.index };
  }

  function planRemoveMessage(ref, context) {
    const message = messageOf(ref, context);
    const name = itemName(context, message);
    return commands([removeStepCommand(context, message)], `Delete ${name}`,
      `Deleted ${name}, from ${nameOf(context, message.step.from)} to ${nameOf(context, message.step.to)}.`);
  }

  /** Deletes a fragment; when it holds steps, the confirmation lists them and offers to unwrap it instead. */
  function planRemoveFragment(ref, context) {
    const fragment = fragmentOf(ref, context);
    const held = fragment.fragment.branches.flatMap((branch, number) => messageSteps(branch.steps, branchPath(fragment, fragment.operator, number)));
    const remove = [removeStepCommand(context, fragment)];
    const label = `Delete the ${fragment.operator}`;
    if (held.length === 0) return commands(remove, label, `Deleted the ${fragment.operator}.`);
    const numbers = numbering(context);
    const unwrap = [{ op: 'unwrapFragment', scenarioId: scenarioId(context), containerPath: fragment.containerPath, index: fragment.index }];
    return commands(remove, label, `Removed the ${fragment.operator}.`, null, { confirm: {
      title: `Delete the ${fragment.operator} and its steps?`,
      message: `The ${fragment.operator} holds ${countOf(held.length, 'step')}. Delete them with it, or unwrap the ${fragment.operator} `
        + 'to keep them in the scenario.',
      details: held.map((entry) => stepDetail(context, entry, numbers)),
      choices: [
        { label: 'Delete with its steps', commands: remove, message: `Deleted the ${fragment.operator} and its steps.` },
        { label: 'Unwrap instead', commands: unwrap, message: `Unwrapped the ${fragment.operator}; its steps stay.` },
        { label: 'Cancel', commands: null },
      ],
    } });
  }

  /**
   * Deletes a lifeline: every step its element sends or receives, from the last to the first so that each position
   * stays valid, after a confirmation that lists them. The element stays in the model (spec §5.3).
   */
  function planRemoveLifeline(ref, context) {
    if (boxOf(ref, context)) return refuse('derived/box', { Name: nameOf(context, boxOf(ref, context)) });
    const id = endId(ref, context);
    const name = nameOf(context, id);
    const numbers = numbering(context);
    const steps = messageSteps(scenario(context).steps).filter(({ step }) => step.from === id || step.to === id);
    const list = steps.slice().reverse().map((entry) => removeStepCommand(context, entry));
    const title = scenario(context).title;
    const message = `Deleted ${steps.length === 1 ? 'the step' : `the ${steps.length} steps`} of ${name}; ${name} stays in the model.`;
    return commands(list, `Delete the lifeline ${name}`, message, null, {
      confirm: {
        title: `Delete the lifeline ${name}?`,
        message: `This deletes every step ${name} sends or receives in ${title}. ${name} stays in the model.`,
        details: steps.map((entry) => stepDetail(context, entry, numbers)), confirmLabel: 'Delete the steps',
      },
    });
  }

  function planRemoveSelection(operation, context) {
    const elements = operation.elements || [];
    const relations = operation.relations || [];
    const fragments = operation.fragments || [];
    const activations = operation.activations || [];
    if (elements.length + relations.length + fragments.length + activations.length !== 1) return refuseWith(ONE_AT_A_TIME);
    if (activations.length === 1) return refuse('not-in-model/sequence-detail');
    if (fragments.length === 1) return planRemoveFragment(fragments[0], context);
    if (relations.length === 1) return planRemoveMessage(relations[0], context);
    return planRemoveLifeline(typeof elements[0] === 'object' ? elements[0].id : elements[0], context);
  }

  // ---- Fragments (spec §5.3) -------------------------------------------------------------------------------

  function planFragmentAdd(operation, context) {
    const operator = operation.operator || null;
    if (operator && !FRAGMENT_OPERATORS.includes(operator)) return refuse('not-in-model/fragment');
    if (operation.wrap) return wrapForm(context, operator, operation.wrap, operation.guard);
    const position = positionOf(operation.at, context);
    const places = allPlaces(context);
    return { kind: 'form', form: 'fragment', label: 'Add a fragment', initial: {
      mode: 'add', scenarioId: scenarioId(context), operator, operators: FRAGMENT_OPERATORS.slice(),
      guard: guardText(operation.guard), position, at: atOf(position, places), places,
    } };
  }

  function guardText(guard) {
    return guard && typeof guard.text === 'string' ? guard.text : '';
  }

  /** "Wrap in a fragment…": the operator, and the last step to include, from the steps that follow in the same list. */
  function wrapForm(context, operator, wrap, guard) {
    const first = itemPositionOnLine(context, wrap.fromLine);
    const lastLine = itemPositionOnLine(context, wrap.toLine);
    const list = listAt(scenario(context).steps, first.containerPath);
    const numbers = numbering(context);
    const lastChoices = list.map((item, index) => ({ index, label: upperFirst(itemName(context, { containerPath: first.containerPath, index }, numbers)) }))
      .filter((choice) => choice.index >= first.index);
    const last = lastLine && sameList(lastLine.containerPath, first.containerPath) && lastLine.index >= first.index ? lastLine.index : first.index;
    return { kind: 'form', form: 'fragment', label: 'Wrap in a fragment', initial: {
      mode: 'wrap', scenarioId: scenarioId(context), operator, operators: FRAGMENT_OPERATORS.slice(), guard: guardText(guard),
      first, lastChoices, last, position: first, at: first, places: [],
    } };
  }

  function itemPositionOnLine(context, line) {
    const entry = context.uml.source.lines[line];
    if (!entry || (entry.kind !== 'message' && entry.kind !== 'fragment')) throw new TypeError(`Line ${line} of the dynamic view is no step`);
    return positionCopy(entry);
  }

  function guardCommand(context, position, branch, when) {
    return { op: 'setBranchGuard', scenarioId: scenarioId(context), containerPath: position.containerPath, index: position.index, branch, when };
  }

  /** The fragment form's answer: `addFragment` at its place, or `wrapSteps`, each with the first guard when one is given. */
  function fragmentFromForm(answer, context) {
    const operator = answer.operator;
    if (!FRAGMENT_OPERATORS.includes(operator)) return refuse('not-in-model/fragment');
    const guard = String(answer.guard || '').trim();
    const values = { operator };
    if (answer.mode === 'wrap') {
      const first = positionCopy(answer.first);
      const wrap = { op: 'wrapSteps', scenarioId: scenarioId(context), containerPath: first.containerPath, from: first.index, to: answer.last, operator };
      return commands([wrap].concat(guard ? [guardCommand(context, first, 0, guard)] : []), `Wrap in ${operator}`,
        `Wrapped ${countOf(answer.last - first.index + 1, 'step')} in ${operator}.`, stepSelection(context, first), { values });
    }
    const position = positionOf(answer.at, context);
    const add = { op: 'addFragment', scenarioId: scenarioId(context), containerPath: position.containerPath, index: position.index, operator };
    return commands([add].concat(guard ? [guardCommand(context, position, 0, guard)] : []), `Add ${operator}`,
      `Added ${operator}, ${lowerFirst(placeLabel(context, position, numbering(context)))}.`, stepSelection(context, position), { values });
  }

  /** The index of branch `branch` of the drawn fragment: none is the first; a drawn guard line; or the index itself. */
  function branchIndex(fragment, branch, context) {
    if (branch === null || branch === undefined || branch === fragment.line) return 0;
    const drawn = entries(context, 'branch').find((entry) => entry.line === branch && entry.index === fragment.index
      && sameList(entry.containerPath, fragment.containerPath));
    return drawn ? drawn.branch : branch;
  }

  function fragmentCommand(op, fragment, context, fields = {}) {
    return Object.assign({ op, scenarioId: scenarioId(context), containerPath: fragment.containerPath, index: fragment.index }, fields);
  }

  /** A fragment's operator (`setFragmentOperator`) and a branch's guard (`setBranchGuard`), in one batch. */
  function planFragmentUpdate(operation, context) {
    const fragment = fragmentOf(operation.ref, context);
    const list = [];
    if (operation.operator && operation.operator !== fragment.operator) {
      if (!FRAGMENT_OPERATORS.includes(operation.operator)) return refuse('not-in-model/fragment');
      list.push(fragmentCommand('setFragmentOperator', fragment, context, { operator: operation.operator }));
    }
    if (operation.guard) {
      list.push(fragmentCommand('setBranchGuard', fragment, context, {
        branch: branchIndex(fragment, operation.guard.branch, context), when: String(operation.guard.text || '').trim() }));
    }
    if (list.length === 0) return nothingToDo();
    const operator = operation.operator || fragment.operator;
    return commands(list, `Edit the ${fragment.operator}`, `Changed the ${fragment.operator}${operator !== fragment.operator ? ` to ${operator}` : ''}.`,
      stepSelection(context, fragment), { values: { operator } });
  }

  function planAddBranch(operation, context) {
    const fragment = fragmentOf(operation.ref, context);
    return commands([fragmentCommand('addBranch', fragment, context, { when: guardText(operation.guard).trim() })],
      `Add a branch to the ${fragment.operator}`, `Added branch ${fragment.fragment.branches.length + 1} to the ${fragment.operator}.`,
      stepSelection(context, fragment), { values: { operator: fragment.operator } });
  }

  function planRemoveBranch(operation, context) {
    const fragment = fragmentOf(operation.ref, context);
    const branch = branchIndex(fragment, operation.branch, context);
    return commands([fragmentCommand('removeBranch', fragment, context, { branch })], `Remove branch ${branch + 1} of the ${fragment.operator}`,
      `Removed branch ${branch + 1} of the ${fragment.operator} with its steps.`, stepSelection(context, fragment), { values: { operator: fragment.operator } });
  }

  function planUnwrap(operation, context) {
    const fragment = fragmentOf(operation.ref, context);
    return commands([fragmentCommand('unwrapFragment', fragment, context)], `Unwrap the ${fragment.operator}`,
      `Unwrapped the ${fragment.operator}; its steps stay.`);
  }

  // ---- Lifelines (spec §5.3, §6) ---------------------------------------------------------------------------

  /** The drawn lifelines in their order, each `{ id, alias, boxId }`. */
  function lifelines(context) {
    return entries(context, 'participant').map((entry) => ({ id: entry.id, alias: aliasOf(entry.id, context), boxId: entry.boxId || null }));
  }

  const unitOf = (drawn) => (id) => {
    const lifeline = drawn.find((candidate) => candidate.id === id);
    return lifeline && lifeline.boxId ? `box:${lifeline.boxId}` : id;
  };

  /** Each unit's members together, at the place of its first member, as the drawing keeps a box's lifelines (§4.2). */
  function keepUnitsTogether(order, unit) {
    const done = new Set();
    return order.flatMap((id) => {
      if (done.has(unit(id))) return [];
      done.add(unit(id));
      return order.filter((other) => unit(other) === unit(id));
    });
  }

  /**
   * The one lifeline whose move turns `drawn` into `requested` (a drag moves one), or null. When two neighbours swap,
   * either one's move gives the order, and this returns the first drawn; a gesture that knows says so with `moved`.
   */
  function movedLifeline(drawn, requested) {
    const without = (order, id) => JSON.stringify(order.filter((other) => other !== id));
    return drawn.find((id) => requested.indexOf(id) !== drawn.indexOf(id) && without(drawn, id) === without(requested, id)) || null;
  }

  /** The units (a box, or a lifeline in no box) of `order` in their order, each once. */
  function unitsOf(order, unit) {
    return order.map(unit).filter((name, index, all) => all.indexOf(name) === index);
  }

  /**
   * The lifeline order a drag asks for, as it is drawn: a lifeline dropped among the lifelines of its box moves there;
   * dropped outside its box, it takes the whole box along, in its order (spec §7.4 "Reorder lifelines"). `named` is the
   * lifeline the gesture says it moves (a menu's "Move left" knows it); without one, the lifeline is inferred from the
   * two orders, which is ambiguous when two neighbours swap. `boxMoved` is true when a box of several lifelines changed
   * its place among the other boxes and lifelines.
   */
  function requestedOrder(drawn, requested, named) {
    const ids = drawn.map((lifeline) => lifeline.id);
    const unit = unitOf(drawn);
    const moved = (named && ids.includes(named) ? named : null) || movedLifeline(ids, requested);
    let order = requested.slice();
    if (moved) {
      const members = ids.filter((id) => unit(id) === unit(moved));
      const at = order.indexOf(moved);
      const first = Math.min(...members.map((id) => order.indexOf(id)));
      const last = Math.max(...members.map((id) => order.indexOf(id)));
      if (last - first + 1 !== members.length) {
        order = order.slice(0, at).filter((id) => !members.includes(id)).concat(members, order.slice(at + 1).filter((id) => !members.includes(id)));
      }
    }
    order = keepUnitsTogether(order, unit);
    const boxMoved = Boolean(moved) && ids.filter((id) => unit(id) === unit(moved)).length > 1
      && unitsOf(order, unit).indexOf(unit(moved)) !== unitsOf(ids, unit).indexOf(unit(moved));
    return { order, moved, boxMoved };
  }

  function reorderPlan(context, order, words) {
    return commands([{ op: 'setUmlLayout', viewKey: context.viewModel.key, lifelines: order }], words.label, words.message);
  }

  function planReorder(operation, context) {
    const drawn = lifelines(context);
    const requested = (operation.order || []).map((ref) => endId(ref, context));
    const named = operation.moved == null ? null : endId(operation.moved, context);
    const { order, moved, boxMoved } = requestedOrder(drawn, requested, named);
    if (JSON.stringify(order) === JSON.stringify(drawn.map((lifeline) => lifeline.id))) return nothingToDo();
    return reorderPlan(context, order, reorderWords(context, drawn, order, { moved, boxMoved }));
  }

  /**
   * A lifeline head dragged sideways (spec §7.4 "Drag a head sideways"). A sequence diagram keeps no free positions, so
   * only positions that name drawn lifelines mean anything, and only their order: the move may start (asked with the
   * head where it is drawn, before the drag has scene facts), and its drop, with the drawn heads as the scene fact
   * `positions`, is the lifeline order by x. Anything else, or a route, is refused with layout/sequence-order.
   */
  function planLayoutSet(operation, context) {
    const drawn = lifelines(context);
    const refs = Object.keys(operation.positions || {});
    const isHead = (ref) => drawn.some((lifeline) => lifeline.alias === ref);
    if (refs.length === 0 || !refs.every(isHead) || (operation.routes || []).length > 0) return refuseWith(NO_POSITIONS);
    const heads = operation.facts && operation.facts.positions;
    if (!heads) return keepOrderPlan(context, drawn);
    const xOf = (lifeline) => (operation.positions[lifeline.alias] || heads[lifeline.alias] || { x: 0 }).x;
    const order = drawn.slice().sort((a, b) => xOf(a) - xOf(b)).map((lifeline) => lifeline.alias);
    return planReorder({ order, moved: refs.length === 1 ? refs[0] : null }, context);
  }

  /** The plan of a lifeline order kept as it is drawn: what a head's move may start from (planLayoutSet). */
  function keepOrderPlan(context, drawn) {
    const ids = drawn.map((lifeline) => lifeline.id);
    return reorderPlan(context, ids, { label: 'Reorder the lifelines', message: null });
  }

  /** The undo label and the announcement of a reorder: what moved, and before which lifeline it now stands. */
  function reorderWords(context, drawn, order, { moved, boxMoved }) {
    if (!moved) return { label: 'Reorder the lifelines', message: 'Changed the order of the lifelines.' };
    const unit = unitOf(drawn);
    const members = order.filter((id) => unit(id) === unit(moved));
    const lifeline = drawn.find((candidate) => candidate.id === moved);
    const subject = boxMoved && lifeline.boxId ? `the ${nameOf(context, lifeline.boxId)} box with its lifelines` : nameOf(context, moved);
    const last = boxMoved ? members[members.length - 1] : moved;
    const next = order[order.indexOf(last) + 1];
    return { label: `Move ${subject}`, message: `Moved ${subject} ${next ? `before ${nameOf(context, next)}` : 'to the end'}.` };
  }

  /**
   * "Move left" or "Move right" (`step` -1 or 1) of lifeline `id`: inside its box it swaps with its neighbour; at the
   * box's edge the whole box moves past the neighbouring lifeline or box. Null at the end of the diagram.
   */
  function shiftedOrder(drawn, id, step) {
    const unit = unitOf(drawn);
    const units = [];
    drawn.forEach((lifeline) => {
      const last = units[units.length - 1];
      if (last && unit(last[0]) === unit(lifeline.id)) last.push(lifeline.id);
      else units.push([lifeline.id]);
    });
    const at = units.findIndex((members) => members.includes(id));
    const members = units[at];
    const inside = members.indexOf(id) + step;
    if (inside >= 0 && inside < members.length) {
      [members[inside - step], members[inside]] = [members[inside], members[inside - step]];
    } else if (at + step >= 0 && at + step < units.length) {
      [units[at], units[at + step]] = [units[at + step], units[at]];
    } else {
      return null;
    }
    return units.flat();
  }

  function planRename(operation, context) {
    const box = boxOf(operation.ref, context);
    if (box) return refuse('derived/box', { Name: nameOf(context, box) });
    const id = endId(operation.ref, context);
    return { kind: 'action', action: 'renameElement', args: [id, operation.text, { wording: 'model-wide' }],
      label: `Rename ${nameOf(context, id)} everywhere in the model` };
  }

  function planElementUpdate(operation, context) {
    const box = boxOf(operation.ref, context);
    return box ? refuse('derived/box', { Name: nameOf(context, box) }) : refuse('not-in-model/sequence-detail');
  }

  /** A palette tool: Message opens the step form (with no lifeline yet, every allowed end), Fragment the fragment form. */
  function planElementAdd(operation, context) {
    const tool = operation.tool;
    const at = operation.at || operation.anchor || null;
    if (tool === MESSAGE_TOOL.id) return addStepForm(context, null, null, positionOf(at, context));
    if (tool === FRAGMENT_TOOL.id || FRAGMENT_OPERATORS.includes(tool)) {
      return planFragmentAdd({ operator: tool === FRAGMENT_TOOL.id ? null : tool, at }, context);
    }
    if (UNAVAILABLE_BY_ID.has(tool)) return refuse(UNAVAILABLE_BY_ID.get(tool).code);
    if (LIFELINE_TOOLS.has(tool)) return refuse('not-in-model/lifeline');
    throw new TypeError(`A dynamic view has no tool ${JSON.stringify(tool)}`);
  }

  const PLANNERS = {
    'element.add': planElementAdd,
    'element.rename': planRename,
    'element.update': planElementUpdate,
    'element.duplicate': () => refuse('not-in-model/duplicate'),
    'element.remove': (operation, context) => planRemoveLifeline(operation.ref, context),
    'selection.remove': planRemoveSelection,
    'relation.add': planRelationAdd,
    'relation.update': planRelationUpdate,
    'relation.rewire': planRewire,
    'relation.invert': planInvert,
    'lifeline.add': () => refuse('not-in-model/lifeline'),
    'lifeline.reorder': planReorder,
    'message.move': planMove,
    'fragment.add': planFragmentAdd,
    'fragment.update': planFragmentUpdate,
    'fragment.addBranch': planAddBranch,
    'fragment.removeBranch': planRemoveBranch,
    'fragment.unwrap': planUnwrap,
    'fragment.move': planMove,
    'activation.add': () => refuse('not-in-model/sequence-detail'),
    'activation.set': () => refuse('not-in-model/sequence-detail'),
    'layout.set': planLayoutSet,
    'layout.reset': (operation, context) => siblings().layout.planReset(operation.target, context),
  };

  /** What `operation` means in this dynamic view: a plan for the C4 model adapter (plan Task 34). */
  function plan(operation, context) {
    const planner = PLANNERS[operation.op];
    if (!planner) throw new TypeError(`A dynamic view plans no ${operation.op}`);
    return planner(operation, context);
  }

  /** What an anchored form's answer means: the step form's and the fragment form's (see the file's head). */
  function fromForm(form, values, context) {
    if (form === 'step') return stepFromForm(values, context);
    if (form === 'fragment') return fragmentFromForm(values, context);
    throw new TypeError(`A dynamic view has no form ${JSON.stringify(form)}`);
  }

  /**
   * Advice for a gesture with one open end: for a message being drawn (`relation.add`, open 'from' or 'to') and for a
   * message's end being moved (`relation.rewire`, open 'to'), each lifeline as that end and the refusal, if any, its
   * plan gives (spec §3.4 `targets`). Null for any other gesture.
   */
  function targets(request, context) {
    const drawing = request.op === 'relation.add' && OPEN_ENDS.includes(request.open);
    const rewiring = request.op === 'relation.rewire' && request.open === 'to';
    if (!drawing && !rewiring) return null;
    const field = rewiring ? 'to' : request.open;
    return lifelines(context).map(({ alias }) => {
      const planned = plan(Object.assign({}, request, { [field]: alias }), context);
      const refused = planned.kind === 'refuse' && planned.code !== 'cancelled';
      return { ref: alias, ok: !refused, code: refused ? planned.code : null, values: refused ? planned.values : undefined,
        summary: refused && planned.summary ? planned.summary : undefined };
    });
  }

  // ---- Menus (spec §7.4, single-pointer paths) -------------------------------------------------------------

  function moveItem(label, ref, at, context) {
    const op = isMessageRef(ref) ? 'message.move' : 'fragment.move';
    return { label, operation: { op, ref, at } };
  }

  function lifelineMenu(ref, context) {
    const drawn = lifelines(context);
    const id = endId(ref, context);
    return [['Move left', -1], ['Move right', 1]].map(([label, step]) => {
      const order = shiftedOrder(drawn, id, step);
      if (!order) {
        const edge = step < 0 ? 'first' : 'last';
        return { label, refusal: { summary: `Already ${edge}`, message: `${nameOf(context, id)} is the ${edge} lifeline already.` } };
      }
      const refOfLifeline = (other) => aliasOf(other, context) || other;
      return { label, operation: { op: 'lifeline.reorder', order: order.map(refOfLifeline), moved: refOfLifeline(id) } };
    });
  }

  function stepMenu(ref, context) {
    const item = movedItem(ref, context);
    const items = [moveItem('Move earlier', ref, { step: -1 }, context), moveItem('Move later', ref, { step: 1 }, context)];
    const list = listAt(scenario(context).steps, item.containerPath);
    const following = list.slice(item.index + 1).findIndex((step) => step.kind === 'fragment');
    if (following >= 0) {
      const fragment = { containerPath: item.containerPath, index: item.index + 1 + following };
      const operator = list[fragment.index].operator;
      items.push(moveItem(`Move into the following ${operator}`, ref, { containerPath: branchPath(fragment, operator, 0), index: 0 }, context));
    }
    const segments = segmentsOf(scenario(context).steps, item.containerPath);
    if (segments.length > 0) {
      const parent = parentPosition(item.containerPath);
      items.push(moveItem('Move out of the fragment', ref, { containerPath: parent.containerPath, index: parent.index + 1 }, context));
    }
    if (item.kind === 'message') {
      items.push({ label: 'Wrap in a fragment…', operation: { op: 'fragment.add', operator: null, wrap: { fromLine: item.line, toLine: item.line } } });
      items.push({ label: 'Edit step…', operation: { op: 'relation.update', ref, changes: {} } });
      return items;
    }
    if (MULTI_BRANCH.includes(item.operator) && item.fragment.branches.length > 1) {
      item.fragment.branches.forEach((branch, number) => items.push({ label: `Remove branch ${number + 1}`,
        operation: { op: 'fragment.removeBranch', ref, branch: number } }));
    }
    items.push({ label: `Unwrap the ${item.operator}`, operation: { op: 'fragment.unwrap', ref } });
    return items;
  }

  /** The position of the fragment whose branch is the step list `containerPath` (`[…, index, op, branch]` or `[…, index, op]`). */
  function parentPosition(containerPath) {
    const at = containerPath.length - (typeof containerPath[containerPath.length - 1] === 'number' ? 3 : 2);
    const parent = containerPath.slice(0, at);
    return { containerPath: parent[parent.length - 1] === 'steps' ? parent.slice(0, -1) : parent, index: containerPath[at] };
  }

  /** The view's own menu items of option `ref` (`[{ label, operation | refusal }]`), after the host's. */
  function menu(ref, context) {
    if (typeof ref === 'string' && (MESSAGE_REF.test(ref) || FRAGMENT_REF.test(ref))) return stepMenu(ref, context);
    if (Object.prototype.hasOwnProperty.call(context.uml.ids, ref)) return lifelineMenu(ref, context);
    return [];
  }

  // ---- What the view offers (spec §7.3, §5.6) -------------------------------------------------------------

  function tools() {
    return {
      elements: [Object.assign({}, MESSAGE_TOOL), Object.assign({}, FRAGMENT_TOOL, { operators: FRAGMENT_OPERATORS.slice() })],
      relations: [Object.assign({}, MESSAGE_TOOL)],
      unavailable: UNAVAILABLE_TOOLS.map((tool) => Object.assign({}, tool, { values: {} })),
    };
  }

  /**
   * The option sets of the listbox (spec §7.3): "Lifelines", then "Steps" (messages and fragments in reading order).
   * A set the drawing leaves empty is left out. Each description says in words what the drawing shows by its shape.
   */
  function optionSets(context) {
    const drawn = lifelines(context);
    const numbers = numbering(context);
    const lifelineOptions = drawn.map((lifeline, at) => ({
      ref: lifeline.alias, name: nameOf(context, lifeline.id),
      description: [`lifeline ${at + 1} of ${drawn.length}`].concat(lifeline.boxId ? [`in ${nameOf(context, lifeline.boxId)}`] : []).join('; '),
    }));
    const stepOptions = context.uml.source.lines.map((entry, line) => {
      if (!entry || (entry.kind !== 'message' && entry.kind !== 'fragment')) return null;
      return entry.kind === 'message' ? messageOption(context, line, entry, numbers) : fragmentOption(context, line, entry);
    }).filter(Boolean);
    return [
      { id: 'lifelines', label: 'Lifelines', options: lifelineOptions },
      { id: 'steps', label: 'Steps', options: stepOptions },
    ].filter((set) => set.options.length > 0);
  }

  function messageOption(context, line, entry, numbers) {
    const step = itemAt(context, entry);
    const where = containerPhrase(context, entry.containerPath);
    return {
      ref: `seqmsg:${line}`,
      name: `Step ${numbers.get(positionKey(entry))}: ${nameOf(context, step.from)} to ${nameOf(context, step.to)}`,
      description: [STATUS_WORDS[entry.status] || 'step', step.description || 'no description'].concat(where ? [where] : []).join('; '),
    };
  }

  function fragmentOption(context, line, entry) {
    const fragment = itemAt(context, entry);
    const where = containerPhrase(context, entry.containerPath);
    const guards = fragment.branches.map((branch) => branch.when || 'no guard').join(' / ');
    const count = fragment.branches.length;
    return {
      ref: `frag:${line}`, name: `${entry.operator}: ${guards}`,
      description: [`fragment with ${count === 1 ? 'one branch' : `${count} branches`}`].concat(where ? [where] : []).join('; '),
    };
  }

  /** A dynamic view holds no position; its one layout freedom is the order of its lifelines (spec §4.2). */
  function holders() {
    return new Set();
  }

  function layoutRefusal() {
    return null;
  }

  /** The selection an option stands for: a lifeline's element, a message's or a fragment's step (plan Task 42). */
  function selectionOf(ref, context) {
    if (typeof ref === 'string' && (MESSAGE_REF.test(ref) || FRAGMENT_REF.test(ref))) {
      const entry = context.uml.source.lines[Number(ref.slice(ref.indexOf(':') + 1))];
      return entry && (entry.kind === 'message' || entry.kind === 'fragment') ? stepSelection(context, entry) : null;
    }
    return Object.prototype.hasOwnProperty.call(context.uml.ids, ref) ? { elementId: context.uml.ids[ref] } : null;
  }

  /** The option a selection from the outline or a form stands for, or null when the drawing has none. */
  function refOf(selection, context) {
    if (!selection) return null;
    const step = selection.step || (Array.isArray(selection.containerPath) && Number.isInteger(selection.index) ? selection : null);
    if (step && (!selection.scenarioId || selection.scenarioId === scenarioId(context))) {
      const line = context.uml.source.lines.findIndex((entry) => entry && (entry.kind === 'message' || entry.kind === 'fragment')
        && samePosition(entry, step));
      if (line < 0) return null;
      return `${context.uml.source.lines[line].kind === 'message' ? 'seqmsg' : 'frag'}:${line}`;
    }
    return selection.elementId ? aliasOf(selection.elementId, context) : null;
  }

  const view = {
    notation: NOTATION, editable: true, optionSets, tools, plan, fromForm, targets, menu, places: placesFor, holders, layoutRefusal,
    selectionOf, refOf,
  };
  return view;
});
