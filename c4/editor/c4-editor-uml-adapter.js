(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () { return require('../../diagram-editor/de-operations.js'); });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.umlAdapter = factory(root.ArchUMLC4, function () { return (root.ArchUMLDiagramEditorParts || {}).operations; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, operationsPart) {
  'use strict';

  // The C4 model adapter (UML-view editing spec §3.4, §5.1; plan Task 36): the edit adapter the diagram editor's
  // session talks to on a C4 editor's UML-notation view. It reads the drawing for the module (`contents`, `tools`) and
  // turns each operation into a change of design.yml, or a refusal in the learner's words. It decides nothing about the
  // model itself:
  //
  // - what an operation means in a view is the view module's `plan` (c4-editor-uml-<view>.js), and in the layout the
  //   layout planner's (c4-editor-uml-layout.js);
  // - whether the model takes it is the C4 core's, asked by a dry run of the plan's commands, and the editor state's for
  //   a lock; a plan's commands reach the document as one `batch` through `state.dispatch` (one change, one undo step);
  // - a shared action (rename, delete, the relationship form) is called, never re-implemented, and announces its own
  //   result, so the verdict of an action plan has no message;
  // - the words of a refusal are the refusal table's (c4-editor-uml-refusals.js), filled with the values the plan gives;
  //   a core refusal whose code the table lacks passes on with the core's message, as the editor shows it.
  //
  // `apply` refuses an operation built against another drawing (`stale`), and checks again after a form or a
  // confirmation: the document may change while the learner answers (a tutorial's Reset, YAML typed elsewhere).
  //
  // A plan is `{ kind: 'commands', commands, label, select, message, confirm, values }`, `{ kind: 'action', action,
  // args }`, `{ kind: 'form', form, initial, placement }`, or `{ kind: 'refuse', code, values, offer }` (plan Task 34).
  // `values` fill the table's sentence of a code the core may refuse with. An offer may carry `commands`; it is dropped
  // when the core or a lock would refuse them.

  const SOURCE_REFUSAL = {
    code: 'not-in-model/source',
    summary: 'Not part of this design model',
    message: 'This view changes the design model, not the text of its drawing.',
  };
  const MENU_SUMMARY_LIMIT = 60;
  // The keys of an action's result that name what it changed, kept as the verdict's `select`.
  const SELECTION_KEYS = ['elementId', 'relationshipId', 'interfaceId', 'environmentId', 'nodeId', 'scenarioId'];
  const ROUTE_RELATIONS = new Set(['collaborator']);
  // Every box of a deployment drawing can be pressed, dragged, and dropped on (see readContents).
  const DEPLOYMENT_BOX_AXIS = 'xy';
  const LINE_ENDS = /^\s*([A-Za-z0-9_]+)\s+\S+\s+([A-Za-z0-9_]+)(.*)$/;
  const GUARD = /\[([^\]]*)\]/;

  /**
   * The adapter of one editor. `options`: `state` (the editor state), `actions` (the shared actions), `views` (the view
   * modules by notation, `ArchUMLC4EditorParts.umlViews`), `refusals` (the refusal table), `layout` (the layout
   * planner), `confirm(request) → Promise<boolean | choice | null>`, `dialogs` (`openMenu(spec)`: the editor's menu
   * helper, for the `choose` form), `forms` (`{ <name>: open(initial, placement) → Promise<values | null> }`, this
   * editor's forms), `drawing()` (the canvas's current drawing, `{ viewModel, uml, droppedRoutes, boxes, frame }`, where
   * `frame` is where the layout's origin lies in the drawing; without it the adapter projects the open view itself),
   * and `profile` ('novice' | 'expert').
   */
  function createUmlAdapter(options) {
    const { state, refusals, layout } = options;
    const actions = options.actions || {};
    const views = options.views || {};
    const forms = options.forms || {};
    const dialogs = options.dialogs || {};
    const profile = options.profile || 'expert';

    function operations() {
      const part = operationsPart();
      if (!part) throw new Error('The C4 model adapter needs the diagram editor\'s core scripts (de-operations.js) loaded first');
      return part;
    }

    // ---- The drawing and its context -------------------------------------------------------------------------

    function currentDrawing() {
      const drawn = options.drawing ? options.drawing() : null;
      if (drawn && drawn.uml && drawn.viewModel) {
        return { viewModel: drawn.viewModel, uml: drawn.uml, droppedRoutes: drawn.droppedRoutes || [], boxes: drawn.boxes || null,
          frame: drawn.frame || null };
      }
      const viewModel = C4.project(state.getDesign(), state.getView());
      return { viewModel, uml: C4.toUml(viewModel), droppedRoutes: [], boxes: null, frame: null };
    }

    /** What a view module and the layout planner read (plan Task 34's context, with the drawing's dropped routes). */
    function contextNow() {
      const drawn = currentDrawing();
      return {
        design: state.getDesign(), viewModel: drawn.viewModel, uml: drawn.uml, profile, checksReleased: state.checksReleased(),
        revision: operations().revisionOf(drawn.uml.text), layout: drawn.viewModel.layout, droppedRoutes: drawn.droppedRoutes,
        boxes: drawn.boxes, frame: drawn.frame,
      };
    }

    /** The view module of the drawn view when it plans edits, else null. */
    function moduleOf(context) {
      const module = views[context.viewModel.notation];
      return module && module.editable && typeof module.plan === 'function' ? module : null;
    }

    // ---- Reading -------------------------------------------------------------------------------------------

    /** What the drawn document means (spec §3.4 `contents`), with the model ref of each item and the drawing's revision. */
    function contents() {
      const context = contextNow();
      const module = views[context.viewModel.notation];
      const holders = module && typeof module.holders === 'function' ? module.holders(context) : new Set();
      return readContents(context, holders);
    }

    /** The palette of the drawn view: the module's tools, each unavailable one with the table's short reason and sentence. */
    function tools() {
      const context = contextNow();
      const module = views[context.viewModel.notation];
      const given = module && typeof module.tools === 'function' ? module.tools(context) : {};
      return Object.assign({ elements: [], relations: [] }, given, {
        unavailable: (given.unavailable || []).map((tool) => {
          if (!tool.code) return tool;
          const verdict = tableVerdict(tool.code, tool.values, context);
          return Object.assign({}, tool, { summary: verdict.summary, message: verdict.message });
        }),
      });
    }

    // ---- Advice and change ---------------------------------------------------------------------------------

    /** A verdict on `operation` with no side effect (spec §5.1 "Capability"). */
    function can(operation) {
      const early = gate(operation);
      if (early) return early;
      const context = contextNow();
      const module = moduleOf(context);
      if (!module) return tableVerdict('read-only', {}, context);
      const plan = module.plan(operation, context);
      if (plan.kind === 'refuse') return refusalOf(plan, context);
      if (plan.kind === 'commands') return commandsRefusal(plan.commands, plan, context) || operations().accepted(plan.select || null, null);
      return operations().accepted(null, null);
    }

    /** The module's advice for each candidate end of a gesture, asked once; null when it gives none or nothing may change. */
    function targets(request) {
      if (state.getMode().readOnly) return null;
      const context = contextNow();
      const module = moduleOf(context);
      const answer = module && typeof module.targets === 'function' ? module.targets(request, context) : null;
      if (!answer) return null;
      return answer.map((candidate) => ({
        ref: candidate.ref, ok: candidate.ok, code: candidate.code || null,
        summary: candidate.ok ? null : candidateSummary(candidate, context),
      }));
    }

    /** Makes the change `operation` means, or refuses it; resolves the verdict (spec §3.4 `apply`). */
    function apply(operation) {
      const early = gate(operation);
      if (early) return Promise.resolve(early);
      const context = contextNow();
      const module = moduleOf(context);
      if (!module) return Promise.resolve(tableVerdict('read-only', {}, context));
      return run(module.plan(operation, context), operation, module);
    }

    /** The refusal every operation gets before the view module is asked: raw source, the editor's mode, another drawing. */
    function gate(operation) {
      if (isSourceOperation(operation)) return sourceRefusal();
      const mode = state.getMode();
      if (mode.readOnly) return tableVerdict(mode.reason, {}, null);
      return operation.revision === currentRevision() ? null : stale();
    }

    async function run(plan, operation, module) {
      if (plan.kind === 'refuse') return refusalOf(plan, contextNow());
      if (plan.kind === 'commands') return runCommands(plan, operation);
      if (plan.kind === 'action') return runAction(plan);
      if (plan.kind === 'form') return runForm(plan, operation, module);
      throw new TypeError(`A view module planned ${JSON.stringify(plan.kind)}, which is no kind of plan`);
    }

    async function runCommands(plan, operation) {
      const before = refusalBeforeDispatch(plan.commands, plan);
      if (before) return before;
      if (!plan.confirm) return dispatch(plan.commands, plan);
      const text = state.getText();
      const answer = await options.confirm(plan.confirm);
      if (changedSince(text, operation)) return stale();
      if (!plan.confirm.choices) return answer ? dispatch(plan.commands, plan) : cancelled();
      if (!answer || !answer.commands) return cancelled();
      // A choice that says its own result ("Unwrapped the alt; its steps stay.") is announced with it.
      const chosen = typeof answer.message === 'string' ? Object.assign({}, plan, { message: answer.message }) : plan;
      return refusalBeforeDispatch(answer.commands, chosen) || dispatch(answer.commands, chosen);
    }

    async function runAction(plan) {
      const action = actions[plan.action];
      if (typeof action !== 'function') throw new TypeError(`The editor has no shared action ${JSON.stringify(plan.action)}`);
      const result = await action(...(plan.args || []));
      if (result && result.ok) return operations().accepted(selectionOfResult(result), null);
      const code = !result || result.cancelled ? 'cancelled' : result.error || 'refused';
      return operations().refused(code, null, null, null);
    }

    async function runForm(plan, operation, module) {
      const text = state.getText();
      const values = await openForm(plan);
      if (values === null || values === undefined) return cancelled();
      if (changedSince(text, operation)) return stale();
      return run(module.fromForm(plan.form, values, contextNow()), operation, module);
    }

    /** The plan's commands as one batch through the editor state: one change and one undo step. */
    function dispatch(commands, plan) {
      const result = state.dispatch({ op: 'batch', commands }, { label: plan.label || undefined });
      if (!result.ok) return coreRefusal(result, plan, contextNow());
      return operations().accepted(plan.select || result.selection || null, plan.message || null);
    }

    // ---- Forms ---------------------------------------------------------------------------------------------

    function openForm(plan) {
      const placement = plan.placement || {};
      if (plan.form === 'choose') return choose(plan.initial, placement);
      const open = forms[plan.form];
      if (typeof open !== 'function') throw new TypeError(`This editor has no form ${JSON.stringify(plan.form)}`);
      return Promise.resolve(open(plan.initial, placement));
    }

    /**
     * The `choose` form: the editor's menu over `initial.options` (`[{ label, note, unavailable, … }]`, named by
     * `initial.label`); resolves the chosen option, or null when the menu closes without a choice. The menu closes
     * before it runs the chosen item, so a close settles only after the item had its turn.
     */
    function choose(initial, placement) {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        dialogs.openMenu({
          label: initial.label,
          placement,
          groups: [{ items: initial.options.map((option) => ({
            label: option.label, note: option.note, unavailable: option.unavailable, run: () => settle(option),
          })) }],
          onClose: () => Promise.resolve().then(() => settle(null)),
        });
      });
    }

    // ---- Refusals ------------------------------------------------------------------------------------------

    function currentRevision() {
      return operations().revisionOf(currentDrawing().uml.text);
    }

    /** Whether the document changed while the learner answered: its text, or the drawing the operation was built on. */
    function changedSince(text, operation) {
      return state.getText() !== text || currentRevision() !== operation.revision;
    }

    /** The refusal a dry run of `commands` or a lock gives, or null when they would be written. */
    function refusalBeforeDispatch(commands, plan) {
      if (state.getMode().readOnly) return tableVerdict(state.getMode().reason, {}, null);
      return commandsRefusal(commands, plan, contextNow());
    }

    function commandsRefusal(commands, plan, context) {
      const dryRun = C4.edit(state.getDesign(), { op: 'batch', commands });
      if (dryRun.error) return coreRefusal(dryRun, plan, context);
      const lock = state.lockRefusal({ op: 'batch', commands });
      return lock ? lockVerdict(lock.message) : null;
    }

    /**
     * A refusal of the core or the state, in the learner's words: a lock with the state's sentence, the mode with the
     * table's, a code of the table with the table's sentence filled from the plan's `values`, any other with the core's
     * message as the editor shows a core refusal.
     */
    function coreRefusal(result, plan, context) {
      if (result.error === 'locked') return lockVerdict(result.message);
      if (refusals.has(result.error)) return tableVerdict(result.error, plan.values, context);
      const summary = result.message && result.message.length <= MENU_SUMMARY_LIMIT ? result.message : null;
      return operations().refused(result.error, summary, state.refusalText(result), null);
    }

    /** A `refuse` plan's verdict, with the plan's offer (or the table's), dropped when its commands would be refused. */
    function refusalOf(plan, context) {
      const verdict = refusals.has(plan.code) ? tableVerdict(plan.code, plan.values, context)
        : operations().refused(plan.code, plan.summary || null, plan.message || null, null);
      const offer = plan.offer !== undefined && plan.offer !== null ? plan.offer : verdict.offer;
      const kept = offer && offer.commands && commandsRefusal(offer.commands, plan, context) ? null : offer;
      return Object.assign({}, verdict, { offer: kept || null });
    }

    function tableVerdict(code, values, context) {
      const released = context ? context.checksReleased : state.checksReleased();
      return refusals.verdict(code, values || {}, { checksReleased: released, profile });
    }

    function lockVerdict(message) {
      return operations().refused('locked', refusals.verdict('locked', {}).summary, message, null);
    }

    function stale() {
      return tableVerdict('stale', {}, null);
    }

    function cancelled() {
      return operations().refused('cancelled', null, null, null);
    }

    function sourceRefusal() {
      return operations().refused(SOURCE_REFUSAL.code, SOURCE_REFUSAL.summary, SOURCE_REFUSAL.message, null);
    }

    function isSourceOperation(operation) {
      const definition = operations().OPERATIONS[operation.op];
      return Boolean(definition) && definition.family === 'source';
    }

    function candidateSummary(candidate, context) {
      if (candidate.summary !== undefined) return candidate.summary;
      return candidate.code && candidate.values && refusals.has(candidate.code) ? tableVerdict(candidate.code, candidate.values, context).summary : null;
    }

    return { contents, tools, can, targets, apply };
  }

  /** What an action's result names as changed (`{ elementId }`, `{ relationshipId }`, …), or null. */
  function selectionOfResult(result) {
    const selection = {};
    SELECTION_KEYS.forEach((key) => { if (typeof result[key] === 'string') selection[key] = result[key]; });
    return Object.keys(selection).length > 0 ? selection : null;
  }

  // ---- contents: the drawing read through its source map -------------------------------------------------------

  /**
   * The contents of the drawing of `context` (spec §3.4): `{ type, revision, elements, relations, fragments,
   * activations }`, with the queries the module's gestures ask: `ownedElementIds(parentId)` (the boxes drawn inside a
   * box); for a sequence drawing `sequenceLines` (its lines) and `lifelineDeclarations(ids)` (whether every one of the
   * lifelines `ids` is declared) and `reorderNamesMoved` (a reorder's operation may name its moved lifeline); for a deployment drawing `deploymentNesting` (how its boxes nest). Each item carries the `line` of the drawn text (without its layout block) it stands for and `ref`,
   * the model thing it stands for, from the source map (spec §4.1); boxes are named by their aliases. `holders` are the
   * aliases of the boxes that can hold a position (their `axis` is 'xy'). In a deployment drawing every node and hosted
   * instance has the axis 'xy', a holder or not: a nested node or an instance is pressed, dragged, and dropped on
   * (spec §5.4), and the view module's targets and its `layout/inside-node` refusal decide every drop, so only the
   * top-level nodes, its holders, keep positions (§14 D4). A ball or socket has the axis 'port': it is a pointer target
   * of the drawing (the end of a line drawn to it, a press the view module refuses to move), never a holder.
   */
  function readContents(context, holders) {
    const { uml, viewModel, design } = context;
    const lines = textLines(uml.text);
    const reading = { type: uml.type, revision: context.revision, elements: [], relations: [], fragments: [], activations: [] };
    // A sequence drawing's lines, which the module's insertion anchors index (spec §4.1: a message's anchor is a line),
    // and whether lifelines `ids` can be reordered: in this view every drawn lifeline stands for an element of the
    // model, so each is declared, and the module may build lifeline.reorder for them.
    if (uml.type === 'sequence') {
      reading.sequenceLines = lines;
      reading.lifelineDeclarations = (ids) => ids.every((id) => reading.elements.some((element) => element.id === id && element.axis === 'order'));
      // A head's drop names the lifeline it moves (`moved`): the view module's announcement says which one moved, and
      // two orders alone leave that open when neighbours swap.
      reading.reorderNamesMoved = true;
    }
    const read = { context, holders, lines, reading, model: design.model, scope: viewModel.scopeId };
    uml.source.lines.forEach((entry, index) => {
      if (entry !== null) READERS[entry.kind](entry, index, read);
    });
    reading.ownedElementIds = (parentId) => descendantsOf(reading.elements, parentId);
    if (uml.type === 'deployment') reading.deploymentNesting = deploymentNestingOf(reading.elements);
    return reading;
  }

  /** The aliases of every box drawn inside box `parentId`, at any depth, nearest first. */
  function descendantsOf(elements, parentId) {
    const owned = [];
    for (let at = -1; at < owned.length; at += 1) {
      const holder = at < 0 ? parentId : owned[at];
      elements.forEach((element) => { if (element.parentId === holder && !owned.includes(element.id)) owned.push(element.id); });
    }
    return owned;
  }

  /**
   * How the boxes of a deployment drawing nest, in the shape the module reads (the text adapter reads the same from
   * the braces): each box by alias with its label, kind, and parent; whether one is a node inside a node; and the
   * nodes around one, nearest first.
   */
  function deploymentNestingOf(elements) {
    const byId = {};
    elements.forEach((element) => {
      byId[element.id] = { name: element.id, label: element.label, kind: element.kind === 'node' ? 'node' : 'component', parentId: element.parentId };
    });
    const ancestorsOf = (id) => {
      const chain = [];
      for (let parent = byId[id] && byId[id].parentId; parent && byId[parent] && !chain.includes(parent); parent = byId[parent].parentId) chain.push(parent);
      return chain;
    };
    return {
      elements: Object.values(byId),
      byId,
      label: (id) => (byId[id] ? byId[id].label || id : id),
      isNestedNode: (id) => Boolean(byId[id] && byId[id].kind === 'node' && byId[id].parentId),
      ancestorsOf,
    };
  }

  /** The drawn text's lines without its layout block, indexed as the source map is. */
  function textLines(text) {
    const lines = text.split('\n');
    const start = lines.indexOf('@layout');
    const end = lines.indexOf('@endlayout');
    return start >= 0 && end > start ? lines.slice(0, start).concat(lines.slice(end + 1)) : lines;
  }

  /** The alias on `line` that the drawing's `ids` map to `id`: the only one, or the one written on the line. */
  function aliasFor(read, id, line) {
    const candidates = Object.keys(read.context.uml.ids).filter((alias) => read.context.uml.ids[alias] === id);
    if (candidates.length <= 1) return candidates[0] || null;
    return candidates.find((alias) => new RegExp(`(^|[^A-Za-z0-9_])${alias}($|[^A-Za-z0-9_])`).test(line)) || candidates[0];
  }

  function addElement(read, index, fields) {
    const id = fields.id === undefined ? aliasFor(read, fields.key, read.lines[index]) : fields.id;
    const axis = fields.axis || (read.holders.has(id) ? 'xy' : 'none');
    read.reading.elements.push({
      id, line: index, kind: fields.kind, label: fields.label, name: fields.name, axis, parentId: fields.parentId || null,
      members: [], ref: fields.ref,
    });
  }

  function nameOf(read, id) {
    const element = read.model.elements.get(id);
    return element ? element.name || id : id;
  }

  function nodeOf(read, id) {
    const environment = read.model.environments.get(read.scope);
    return environment ? environment.nodes.get(id) : undefined;
  }

  /** A drawn line's ends (aliases) and its label, the text after its colon. */
  function lineParts(line) {
    const match = LINE_ENDS.exec(line) || [null, null, null, ''];
    const rest = match[3] || '';
    const colon = rest.indexOf(':');
    return { from: match[1], to: match[2], label: colon >= 0 ? rest.slice(colon + 1).trim() : null };
  }

  function addRelation(read, index, fields) {
    const parts = lineParts(read.lines[index]);
    read.reading.relations.push({
      line: index, routeId: fields.routeId, kind: fields.kind, from: parts.from, to: parts.to, label: parts.label,
      text: fields.text === undefined ? parts.label : fields.text, ref: fields.ref,
    });
  }

  function fragmentAt(read, entry) {
    return read.reading.fragments.find((fragment) => fragment.ref.index === entry.index
      && JSON.stringify(fragment.ref.containerPath) === JSON.stringify(entry.containerPath));
  }

  function guardOn(line) {
    const match = GUARD.exec(line);
    return match ? match[1] : null;
  }

  // One reader per source-map entry kind (spec §4.1's line entries).
  const READERS = {
    element(entry, index, read) {
      const element = read.model.elements.get(entry.id);
      const drawnAsClass = read.context.viewModel.type === 'code';
      addElement(read, index, {
        key: entry.id,
        kind: entry.role ? 'component' : element.type === 'code' ? element.kind : element.type,
        label: drawnAsClass ? aliasFor(read, entry.id, read.lines[index]) : element.name,
        name: element.name,
        ref: { elementId: entry.id },
      });
    },
    member(entry, index, read) {
      const owner = read.reading.elements.filter((element) => element.ref.elementId === entry.id).pop();
      const declared = read.model.elements.get(entry.id).code[entry.list][entry.index];
      owner.members.push({ line: index, list: entry.list, index: entry.index, synthesized: entry.synthesized,
        text: entry.synthesized ? null : String(declared) });
    },
    participant(entry, index, read) {
      addElement(read, index, { key: entry.id, kind: 'participant', label: nameOf(read, entry.id), name: nameOf(read, entry.id),
        axis: 'order', ref: { elementId: entry.id } });
    },
    box(entry, index, read) {
      addElement(read, index, { id: null, kind: 'box', label: nameOf(read, entry.id), name: nameOf(read, entry.id), axis: 'none',
        ref: { elementId: entry.id } });
    },
    node(entry, index, read) {
      const node = nodeOf(read, entry.id);
      addElement(read, index, {
        key: entry.id, kind: 'node', label: node.name, name: node.name, axis: DEPLOYMENT_BOX_AXIS,
        parentId: entry.parentId ? aliasFor(read, entry.parentId, '') : null,
        ref: { environmentId: read.scope, nodeId: entry.id },
      });
    },
    instance(entry, index, read) {
      addElement(read, index, {
        key: `${entry.elementId}@${entry.nodeId}`, kind: 'instance', label: nameOf(read, entry.elementId), name: nameOf(read, entry.elementId),
        axis: DEPLOYMENT_BOX_AXIS, parentId: aliasFor(read, entry.nodeId, ''),
        ref: { elementId: entry.elementId, nodeId: entry.nodeId, environmentId: read.scope },
      });
    },
    port(entry, index, read) {
      const provided = read.model.interfaces.get(entry.interfaceId);
      const name = provided ? provided.name || entry.interfaceId : entry.interfaceId;
      const owner = read.reading.elements.filter((element) => element.ref.elementId === entry.elementId && element.kind === 'component').pop();
      addElement(read, index, {
        key: entry.interfaceId, kind: `${entry.role}-interface`, label: name, name, axis: 'port', parentId: owner ? owner.id : null,
        ref: { interfaceId: entry.interfaceId, elementId: entry.elementId, role: entry.role },
      });
    },
    relation(entry, index, read) {
      const relationship = entry.relationshipId ? read.model.relationships.find((candidate) => candidate.id === entry.relationshipId) : null;
      addRelation(read, index, {
        routeId: ROUTE_RELATIONS.has(entry.relation) ? `rel:${index}` : null, kind: entry.relation,
        text: relationship ? relationship.description : null,
        ref: { relationshipId: entry.relationshipId, relation: entry.relation, from: entry.modelFrom, to: entry.modelTo },
      });
    },
    message(entry, index, read) {
      addRelation(read, index, { routeId: `seqmsg:${index}`, kind: entry.status,
        ref: { scenarioId: read.scope, containerPath: entry.containerPath, index: entry.index } });
    },
    link(entry, index, read) {
      addRelation(read, index, { routeId: `rel:${index}`, kind: entry.derived ? 'derived' : 'link',
        ref: { environmentId: read.scope, from: entry.from, to: entry.to, derived: entry.derived, relationshipIds: entry.relationshipIds } });
    },
    assembly(entry, index, read) {
      addRelation(read, index, { routeId: null, kind: 'assembly', text: null,
        ref: { interfaceId: entry.interfaceId, providerId: entry.providerId, consumerId: entry.consumerId } });
    },
    fragment(entry, index, read) {
      read.reading.fragments.push({
        id: `frag:${index}`, operator: entry.operator, startLine: index, endLine: null,
        branches: [{ line: index, index: 0, guard: guardOn(read.lines[index]) }],
        ref: { scenarioId: read.scope, containerPath: entry.containerPath, index: entry.index },
      });
    },
    branch(entry, index, read) {
      fragmentAt(read, entry).branches.push({ line: index, index: entry.branch, guard: guardOn(read.lines[index]) });
    },
    'fragment-end'(entry, index, read) {
      fragmentAt(read, entry).endLine = index;
    },
  };

  return { createUmlAdapter, textLines };
});
