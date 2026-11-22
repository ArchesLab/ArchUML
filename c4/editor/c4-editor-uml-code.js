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

  // The view module of code views, `code of ‹component›`, drawn as UML class diagrams (UML-view editing spec §5.2,
  // §7.3; plan Task 37). It tells the canvas what a code view offers (option sets, tools, which boxes hold a position)
  // and plans what each operation of the diagram editor means in design.yml. It decides nothing the C4 core decides:
  // the C4 model adapter (c4-editor-uml-adapter.js) runs a plan's commands as one batch after a dry run and the lock
  // check, calls the shared action a plan names, and words every refusal by the refusal table. Siblings are read at
  // call time (the core, the shared action helpers, the layout planner, the refusal table), so this file loads in any
  // order.
  //
  // Every member takes the canvas's `context` (plan Task 34): `{ design, viewModel, uml, profile, checksReleased,
  // revision, layout }`. A box is named by its alias in the drawing (`uml.ids` maps it to its model id, so two classes
  // whose names draw alike, "Seat Holds" and "Seat_Holds", stay apart). A line is named by `rel:<n>`, the line of the
  // drawn text without its layout block that the source map (spec §4.1) gives its declared relation; an operation's
  // relation reference `{ routeId, line, candidates }` names it by `line`.
  //
  // A code view draws an element from outside the component as one box ("lifted"), which may stand for something
  // inside it. The plans never build a command from drawn ids alone: a line's declared ends come from the source map.

  const NOTATION = 'uml-class';

  // The palette (spec §5.2; tool ids as the UML editor's class palette names them).
  const ELEMENT_TOOLS = [
    { id: 'class', label: 'Class', glyph: '▢', kind: 'class' },
    { id: 'abstract', label: 'Abstract class', glyph: '■', kind: 'abstract_class' },
    { id: 'interface', label: 'Interface', glyph: '○', kind: 'interface' },
    { id: 'enum', label: 'Enum', glyph: '≡', kind: 'enum' },
    { id: 'function', label: 'Function', glyph: 'ƒ', kind: 'function', profile: 'expert' },
    { id: 'module', label: 'Module', glyph: '▤', kind: 'module', profile: 'expert' },
  ];
  const RELATION_TOOLS = [
    { id: 'gen', label: 'Generalization', glyph: '─▷' },
    { id: 'real', label: 'Realization', glyph: '··▷' },
    { id: 'depend', label: 'Dependency', glyph: '··→' },
  ];
  // The role words an unavailable tool's sentence is filled with: it is listed before any line is drawn. A tool with
  // `line: true` is a kind of line, which the chooser of a drawn line lists too, after the kinds it can draw (§5.6).
  const ROLE_VALUES = { Source: 'the source', Target: 'the target' };
  const UNAVAILABLE_TOOLS = [
    { id: 'compose', label: 'Composition', line: true, code: 'not-in-model/association', values: ROLE_VALUES },
    { id: 'aggregate', label: 'Aggregation', line: true, code: 'not-in-model/association', values: ROLE_VALUES },
    { id: 'assoc', label: 'Association', line: true, code: 'not-in-model/association', values: ROLE_VALUES },
    { id: 'note', label: 'Note', code: 'not-in-model/note', values: {} },
    { id: 'duplicate', label: 'Duplicate', code: 'not-in-model/duplicate', values: {} },
  ];
  const KIND_OF_TOOL = new Map(ELEMENT_TOOLS.map((tool) => [tool.id, tool.kind]));
  const INHERITANCE_OF_TOOL = { gen: 'extends', real: 'implements' };
  // The UML editor's association tools: lines this design model has no place for (spec §5.6).
  const ASSOCIATION_TOOLS = new Set(['compose', 'aggregate', 'assoc', 'biassoc', 'plain']);
  const INHERITANCE = new Set(['extends', 'implements']);
  const MEMBER_LISTS = { attributes: 'attributes', operations: 'operations' };
  const MEMBER_NOUNS = { attributes: 'attribute', operations: 'operation' };
  const KIND_LINES = { class: 'class', abstract_class: 'abstract class', interface: 'interface', enum: 'enum', function: 'function', module: 'module' };
  const TYPE_LINES = { person: 'person', system: 'software system', container: 'container', component: 'component', code: 'code element' };
  const LINE_KINDS = { extends: 'generalization', implements: 'realization', collaborator: 'dependency' };
  // The view that draws an element among its siblings, by the type of its parent (C4 spec §5).
  const CHILD_VIEW = { system: 'containers', container: 'components', component: 'code' };
  const LINE_REF = /^rel:(\d+)$/;
  const OPEN_ENDS = ['from', 'to'];
  // A refusal the table has no row for: a view deletes one drawn thing at a time (the C4 surface selects one).
  const ONE_AT_A_TIME = { code: 'one-at-a-time', summary: 'Delete one thing at a time',
    message: 'Select one element or line and delete it; this view deletes one thing at a time.' };
  // The short reasons of the shared actions' refusals of a dependency's ends (c4-editor-actions-shared.js `endsProblem`
  // and `relationshipMoveProblem` own the sentences), for menus, choosers, and C mode (spec §5.1: one line, ≤ 60).
  const END_SUMMARIES = {
    'unknown-element': 'Not in this design model',
    'self-loop': 'Cannot point at itself',
    containment: 'One contains the other',
    duplicate: 'Already related',
  };

  // ---- Reading the drawing --------------------------------------------------------------------------------

  function model(context) {
    return context.design.model;
  }

  function scopeName(context) {
    return nameOf(context, context.viewModel.scopeId);
  }

  function nameOf(context, id) {
    return siblings().shared.elementName(model(context), id);
  }

  /** The drawn box `alias`: `{ alias, id, lifted }`; a TypeError when the drawing has no such box. */
  function boxOf(alias, context) {
    if (!Object.prototype.hasOwnProperty.call(context.uml.ids, alias)) throw new TypeError(`The code view draws no box ${JSON.stringify(alias)}`);
    const id = context.uml.ids[alias];
    const drawn = context.viewModel.uml.classes.find((candidate) => candidate.id === id);
    return { alias, id, lifted: Boolean(drawn && drawn.lifted) };
  }

  function aliasOf(id, context) {
    return Object.keys(context.uml.ids).find((alias) => context.uml.ids[alias] === id) || null;
  }

  /**
   * The drawn line a reference names (a `rel:<n>` ref, or an operation's `{ line, candidates }`): its source-map
   * entry with the drawn ends (`from`, `to`, model ids of the boxes), the declared ends (`modelFrom`, `modelTo`), and
   * `deep`, which drawn end stands for an element inside its box.
   */
  function lineOf(ref, context) {
    const index = lineIndex(ref);
    const entry = context.uml.source.lines[index];
    if (!entry || entry.kind !== 'relation') throw new TypeError(`Line ${index} of the code view is no line between boxes`);
    return Object.assign({ index }, entry, { deep: { source: entry.from !== entry.modelFrom, target: entry.to !== entry.modelTo } });
  }

  function lineIndex(ref) {
    if (typeof ref === 'string' && LINE_REF.test(ref)) return Number(LINE_REF.exec(ref)[1]);
    if (ref && Number.isInteger(ref.line) && ref.line >= 0) return ref.line;
    if (ref && Array.isArray(ref.candidates) && ref.candidates.length === 1) return lineIndex(ref.candidates[0]);
    if (Number.isInteger(ref) && ref >= 0) return ref;
    throw new TypeError('A code view acts on one line: the C4 surface chooses among the lines that meet at a point first (spec §5.2)');
  }

  function drawnLines(context) {
    return context.uml.source.lines.map((entry, index) => (entry && entry.kind === 'relation' ? lineOf(`rel:${index}`, context) : null)).filter(Boolean);
  }

  /** The view that draws `id` among its siblings, `{ selector, title }`: its parent's child view, or the context view. */
  function homeView(context, id) {
    const elements = model(context).elements;
    const element = elements.get(id);
    const parent = element && element.parentId ? elements.get(element.parentId) : null;
    let top = elements.get(context.viewModel.scopeId);
    while (top && top.parentId) top = elements.get(top.parentId);
    const selector = parent ? `${CHILD_VIEW[parent.type]} of ${parent.id}` : `context of ${top ? top.id : id}`;
    const views = siblings().C4.listViews(context.design);
    return views.find((candidate) => candidate.selector === selector) || views.find((candidate) => candidate.type === 'landscape') || null;
  }

  // ---- Refusals -------------------------------------------------------------------------------------------

  function refuse(code, values = {}, offer = null) {
    return { kind: 'refuse', code, values, offer };
  }

  /** A refusal the table has no row for, with its own words. */
  function refuseWith(words) {
    return { kind: 'refuse', code: words.code, values: {}, offer: null, summary: words.summary, message: words.message };
  }

  /** A refusal whose table offer opens `view` (`{ selector }`): the offer names the view the host opens. */
  function refuseOpening(code, values, view) {
    const offer = siblings().refusals.verdict(code, values).offer;
    return refuse(code, values, offer && view ? Object.assign({}, offer, { view: view.selector }) : null);
  }

  /** The thing `box` stands for is outside the component: rename, delete, or edit it where it is drawn (spec §5.1). */
  function outsideView(box, context) {
    const element = model(context).elements.get(box.id);
    const home = homeView(context, box.id);
    return refuseOpening('outside-view', {
      Name: nameOf(context, box.id), type: element.type, Scope: scopeName(context), 'view title': home ? home.title : scopeName(context),
    }, home);
  }

  /** The end `end` of `line` is drawn at a box that stands for an element inside it (spec §5.1). */
  function liftedEnd(line, end, context) {
    const deepId = end === 'source' ? line.modelFrom : line.modelTo;
    const home = homeView(context, deepId);
    return refuseOpening('outside-view/lifted-end', {
      'Deep name': nameOf(context, deepId), type: model(context).elements.get(deepId).type,
      Box: nameOf(context, end === 'source' ? line.from : line.to), 'view title': home ? home.title : scopeName(context),
    }, home);
  }

  function bothEnds(sourceId, targetId, context) {
    const home = homeView(context, sourceId);
    return refuseOpening('outside-view/both-ends', {
      A: nameOf(context, sourceId), B: nameOf(context, targetId), Scope: scopeName(context), 'view title': home ? home.title : scopeName(context),
    }, home);
  }

  /** The first lifted end of `line` that stands for an element inside its box, as a refusal; or null. */
  function deepEndRefusal(line, context) {
    if (line.deep.source) return liftedEnd(line, 'source', context);
    return line.deep.target ? liftedEnd(line, 'target', context) : null;
  }

  /** A shared action's refusal of a dependency's ends (`{ code, message }`, or null) as a `refuse` plan, or null. */
  function endsRefusal(problem) {
    if (!problem) return null;
    return refuseWith({ code: problem.code, summary: END_SUMMARIES[problem.code] || null, message: problem.message });
  }

  // ---- Inheritance: extends and implements ----------------------------------------------------------------

  /**
   * Why `sourceId` cannot `relation` (extends | implements) `targetId` in `design`, as a refusal with the values its
   * sentence is filled from; the core's kind rule decides (`inheritanceProblem`). Null when it can.
   */
  function inheritanceRefusal(design, sourceId, relation, targetId, context) {
    const elements = design.model.elements;
    const target = elements.get(targetId);
    if (target && target.type === 'code' && elements.get(sourceId).code[relation].includes(targetId)) {
      return refuseWith({ code: 'already-present', summary: 'Already drawn',
        message: `${nameOf(context, sourceId)} already ${relation} ${nameOf(context, targetId)}.` });
    }
    const code = siblings().C4.inheritanceProblem(design, sourceId, relation, targetId);
    if (!code) return null;
    const values = { Source: nameOf(context, sourceId), Target: nameOf(context, targetId), relation, sourceKind: elements.get(sourceId).kind };
    if (target) values.type = target.type;
    if (target && target.type === 'code') values.targetKind = target.kind;
    const view = code === 'extends-target' && target && target.type === 'component' ? { selector: `code of ${targetId}` } : null;
    return refuseOpening(code, values, view);
  }

  /** The design after `commands`, to check a rule against the model they leave (a moved entry is checked without its old place). */
  function designAfter(design, commands) {
    const C4 = siblings().C4;
    const result = C4.edit(design, { op: 'batch', commands });
    return result.error ? design : C4.load(result.text);
  }

  function inheritanceList(elementId, relation, items) {
    return { op: 'setList', elementId, field: relation, items };
  }

  function entriesOf(context, elementId, relation) {
    return model(context).elements.get(elementId).code[relation].slice();
  }

  function inheritancePhrase(context, sourceId, relation, targetId) {
    return `${nameOf(context, sourceId)} ${relation} ${nameOf(context, targetId)}`;
  }

  function commands(list, label, message, select = null) {
    return { kind: 'commands', commands: list, label, select, message, confirm: null };
  }

  function addInheritance(sourceBox, relation, targetBox, context) {
    if (sourceBox.lifted) return outsideView(sourceBox, context);
    const refusal = inheritanceRefusal(context.design, sourceBox.id, relation, targetBox.id, context);
    if (refusal) return refusal;
    const phrase = inheritancePhrase(context, sourceBox.id, relation, targetBox.id);
    return commands([inheritanceList(sourceBox.id, relation, entriesOf(context, sourceBox.id, relation).concat(targetBox.id))],
      `Draw: ${phrase}`, `${phrase} now.`, { elementId: sourceBox.id });
  }

  /**
   * Moves the declared entry of `line` so that `sourceId` `line.relation` `targetId`: one `setList` when the source
   * stays (a new target takes the old one's place), else a batch that removes the entry from the old source and adds
   * it to the new one. The kind rule is checked against the model without the old entry.
   */
  function moveInheritance(line, sourceId, targetId, context, words) {
    const relation = line.relation;
    const remaining = entriesOf(context, line.modelFrom, relation).filter((id) => id !== line.modelTo);
    const removal = inheritanceList(line.modelFrom, relation, remaining);
    const refusal = inheritanceRefusal(designAfter(context.design, [removal]), sourceId, relation, targetId, context);
    if (refusal) return refusal;
    const list = sourceId === line.modelFrom
      ? [inheritanceList(sourceId, relation, entriesOf(context, sourceId, relation).map((id) => (id === line.modelTo ? targetId : id)))]
      : [removal, inheritanceList(sourceId, relation, entriesOf(context, sourceId, relation).concat(targetId))];
    const phrase = inheritancePhrase(context, sourceId, relation, targetId);
    return commands(list, words.label, `${phrase} now${words.instead || ''}.`, { elementId: sourceId });
  }

  // ---- Plans, one per operation (spec §5.2) ---------------------------------------------------------------

  /** Add Class, Abstract class, Interface, Enum (expert: Function, Module), with its position where the view holds them (§6). */
  function planAdd(operation, context) {
    if (operation.tool === 'note') return refuse('not-in-model/note');
    const kind = KIND_OF_TOOL.get(operation.tool);
    if (!kind) throw new TypeError(`A code view has no element tool ${JSON.stringify(operation.tool)}`);
    const { C4, shared, layout } = siblings();
    const name = operation.name || shared.placeholderName('code', kind);
    const add = { op: 'addElement', parentId: context.viewModel.scopeId, type: 'code', kind, name };
    const label = `Add ${name}`;
    const message = `Added ${name} inside ${scopeName(context)}.`;
    const dryRun = C4.edit(context.design, add);
    if (dryRun.error) return commands([add], label, message);
    const elementId = dryRun.selection.elementId;
    const facts = operation.facts || {};
    const holdsPositions = Boolean(context.layout && context.layout.positions.size > 0);
    const at = facts.at || (holdsPositions ? layout.freePlace(context) : null);
    if (!at || (!holdsPositions && operation.placed !== 'dropped')) return commands([add], label, message, { elementId });
    const placing = layout.planMove({ positions: {}, routes: [], added: { [elementId]: at }, facts }, context, view);
    if (placing.kind !== 'commands') return placing;
    return commands([add].concat(placing.commands), label, message, { elementId });
  }

  function planRename(operation, context) {
    const box = boxOf(operation.ref, context);
    if (box.lifted) return outsideView(box, context);
    return { kind: 'action', action: 'renameElement', args: [box.id, operation.text], label: `Rename ${nameOf(context, box.id)}` };
  }

  /** A keyword or stereotype of a box: derived from its kind (spec §5.2), or from another view for a lifted box. */
  function planUpdate(operation, context) {
    const box = boxOf(operation.ref, context);
    return box.lifted ? outsideView(box, context) : refuse('derived/keyword');
  }

  function planRemoveElement(ref, context) {
    const box = boxOf(ref, context);
    if (box.lifted) return outsideView(box, context);
    return { kind: 'action', action: 'deleteElement', args: [box.id], label: `Delete ${nameOf(context, box.id)}` };
  }

  /** Deletes the declared line: an extends or implements entry by its declared target id, a dependency by its relationship. */
  function planRemoveLine(ref, context) {
    const line = lineOf(ref, context);
    if (!INHERITANCE.has(line.relation)) return { kind: 'action', action: 'deleteRelationship', args: [line.relationshipId], label: 'Delete a dependency' };
    const phrase = inheritancePhrase(context, line.modelFrom, line.relation, line.modelTo);
    const items = entriesOf(context, line.modelFrom, line.relation).filter((id) => id !== line.modelTo);
    return commands([inheritanceList(line.modelFrom, line.relation, items)], `Delete: ${phrase}`, `Deleted: ${phrase}.`, { elementId: line.modelFrom });
  }

  function planRemoveSelection(operation, context) {
    const elements = operation.elements || [];
    const relations = operation.relations || [];
    const count = elements.length + relations.length + (operation.fragments || []).length + (operation.activations || []).length;
    if (count !== 1) return refuseWith(ONE_AT_A_TIME);
    return elements.length === 1 ? planRemoveElement(elementRef(elements[0]), context) : planRemoveLine(relations[0], context);
  }

  function elementRef(item) {
    return item && typeof item === 'object' ? item.id : item;
  }

  /**
   * Adds, edits, or deletes an attribute or operation: one `setList` of the model's list, so every other line keeps
   * its model text. A function that declares no operation is drawn with its own call: editing that line writes its
   * first operation, and deleting it is refused.
   */
  function planMember(operation, context) {
    const box = boxOf(operation.owner, context);
    if (box.lifted) return outsideView(box, context);
    const field = MEMBER_LISTS[operation.list];
    if (!field) throw new TypeError(`A code element has no member list ${JSON.stringify(operation.list)}`);
    const element = model(context).elements.get(box.id);
    const declared = element.code[field].slice();
    const synthesized = field === 'operations' && element.kind === 'function' && declared.length === 0;
    const text = String(operation.text === null || operation.text === undefined ? '' : operation.text).trim();
    const noun = MEMBER_NOUNS[field];
    const name = nameOf(context, box.id);
    let words;
    if (operation.op === 'member.remove') {
      if (synthesized) return refuse('derived/function-operation');
      declared.splice(operation.index, 1);
      words = [`Delete an ${noun} of ${name}`, `Deleted an ${noun} of ${name}.`];
    } else if (operation.op === 'member.update') {
      if (synthesized) declared.push(text);
      else declared[operation.index] = text;
      words = [`Edit an ${noun} of ${name}`, `Changed an ${noun} of ${name}.`];
    } else {
      declared.splice(Math.min(Math.max(operation.index, 0), declared.length), 0, text);
      words = [`Add an ${noun} to ${name}`, `Added an ${noun} to ${name}.`];
    }
    return commands([{ op: 'setList', elementId: box.id, field, items: declared }], words[0], words[1], { elementId: box.id });
  }

  /** Draws a line: extends or implements with the kind rule, a dependency through the relationship form. */
  function planRelationAdd(operation, context) {
    const source = boxOf(operation.from, context);
    const target = boxOf(operation.to, context);
    if (ASSOCIATION_TOOLS.has(operation.tool)) {
      return refuse('not-in-model/association', { Source: nameOf(context, source.id), Target: nameOf(context, target.id) });
    }
    const relation = INHERITANCE_OF_TOOL[operation.tool];
    if (relation) return addInheritance(source, relation, target, context);
    if (operation.tool !== 'depend') throw new TypeError(`A code view has no line tool ${JSON.stringify(operation.tool)}`);
    if (source.lifted && target.lifted) return bothEnds(source.id, target.id, context);
    // The shared action would refuse these ends (a dependency on itself, or between nested elements); said up front, so
    // C mode marks the box as not possible and a chooser lists it disabled.
    const ends = endsRefusal(siblings().shared.endsProblem(model(context), source.id, target.id));
    if (ends) return ends;
    // A lifted box stands for its own element: a line drawn to it is a relationship to that element (spec §5.2).
    return { kind: 'action', action: 'openRelationshipForm', args: [{ sourceId: source.id, targetId: target.id }], label: 'Add a dependency' };
  }

  /**
   * Edits a line: a dependency's label is its relationship's description; what UML adds to a line (kind,
   * multiplicity, navigability) has no place in this design model, and a keyword is derived.
   */
  function planRelationUpdate(operation, context) {
    const line = lineOf(operation.ref, context);
    const changes = operation.changes || {};
    if (INHERITANCE.has(line.relation)) {
      return refuseWith({ code: 'not-in-model/inheritance-label', summary: 'Extends and implements have no label',
        message: 'This design model records extends and implements without a label. Explain the reason in the element\'s description.' });
    }
    if (typeof changes.label === 'string') {
      return commands([{ op: 'updateRelationship', relationshipId: line.relationshipId, description: changes.label.trim() }],
        'Edit a dependency', `Changed the description of the dependency from ${nameOf(context, line.modelFrom)} to ${nameOf(context, line.modelTo)}.`,
        { relationshipId: line.relationshipId });
    }
    if ('stereotype' in changes) return refuse('derived/keyword');
    return refuse('not-in-model/association', { Source: nameOf(context, line.modelFrom), Target: nameOf(context, line.modelTo) });
  }

  /** Moves one end of a line to the box `to`; the other end keeps its declared element (spec §5.1). */
  function planRewire(operation, context) {
    const line = lineOf(operation.ref, context);
    const end = operation.end === 'source' ? 'source' : 'target';
    if (line.deep[end]) return liftedEnd(line, end, context);
    const box = boxOf(operation.to, context);
    if (INHERITANCE.has(line.relation)) {
      if (box.lifted && end === 'source') return outsideView(box, context);
      const [sourceId, targetId] = end === 'source' ? [box.id, line.modelTo] : [line.modelFrom, box.id];
      const instead = end === 'source' ? line.modelFrom : line.modelTo;
      return moveInheritance(line, sourceId, targetId, context,
        { label: `Move an end: ${inheritancePhrase(context, sourceId, line.relation, targetId)}`, instead: ` instead of ${nameOf(context, instead)}` });
    }
    const otherDrawn = end === 'source' ? line.to : line.from;
    if (box.lifted && boxOf(aliasOf(otherDrawn, context), context).lifted) {
      return end === 'source' ? bothEnds(box.id, line.modelTo, context) : bothEnds(line.modelFrom, box.id, context);
    }
    const relationship = model(context).relationships.find((candidate) => candidate.id === line.relationshipId);
    const [sourceId, targetId] = end === 'source' ? [box.id, line.modelTo] : [line.modelFrom, box.id];
    const moved = relationship ? endsRefusal(siblings().shared.relationshipMoveProblem(model(context), relationship, sourceId, targetId)) : null;
    if (moved) return moved;
    return { kind: 'action', action: 'moveRelationship', args: [line.relationshipId, end === 'source' ? { sourceId: box.id } : { targetId: box.id }],
      label: 'Move an end of a dependency' };
  }

  /** Turns a line around: extends and implements move their entry to the other element; a dependency swaps its declared ends. */
  function planInvert(operation, context) {
    const line = lineOf(operation.ref, context);
    const refusal = deepEndRefusal(line, context);
    if (refusal) return refusal;
    if (!INHERITANCE.has(line.relation)) {
      return { kind: 'action', action: 'moveRelationship', args: [line.relationshipId, { sourceId: line.modelTo, targetId: line.modelFrom }],
        label: 'Turn a dependency around' };
    }
    return moveInheritance(line, line.modelTo, line.modelFrom, context,
      { label: `Turn around: ${inheritancePhrase(context, line.modelFrom, line.relation, line.modelTo)}` });
  }

  function planLayoutSet(operation, context) {
    return siblings().layout.planMove({ positions: operation.positions, routes: operation.routes, facts: operation.facts || {} }, context, view);
  }

  function planLayoutReset(operation, context) {
    const target = operation.target;
    const refused = target && target.route ? layoutRefusal(target.route, context) : null;
    return refused ? refuse(refused.code, refused.values) : siblings().layout.planReset(target, context);
  }

  const PLANNERS = {
    'element.add': planAdd,
    'element.rename': planRename,
    'element.update': planUpdate,
    'element.duplicate': () => refuse('not-in-model/duplicate'),
    'element.remove': (operation, context) => planRemoveElement(operation.ref, context),
    'selection.remove': planRemoveSelection,
    'member.add': planMember,
    'member.update': planMember,
    'member.remove': planMember,
    'relation.add': planRelationAdd,
    'relation.update': planRelationUpdate,
    'relation.rewire': planRewire,
    'relation.invert': planInvert,
    'layout.set': planLayoutSet,
    'layout.reset': planLayoutReset,
  };

  /** What `operation` means in this code view: a plan for the C4 model adapter (plan Task 34). */
  function plan(operation, context) {
    const planner = PLANNERS[operation.op];
    if (!planner) throw new TypeError(`A code view plans no ${operation.op}`);
    return planner(operation, context);
  }

  /**
   * Advice for a gesture with one open end (`request.open` is 'from' or 'to'): each drawn box as that end, and the
   * refusal, if any, its plan gives (spec §3.4 `targets`). Null for any other open end.
   */
  function targets(request, context) {
    if (!OPEN_ENDS.includes(request.open)) return null;
    return Object.keys(context.uml.ids).map((alias) => {
      const planned = plannedEnd(Object.assign({}, request, { [request.open]: alias }), context);
      const refused = planned.kind === 'refuse';
      return { ref: alias, ok: !refused, code: refused ? planned.code : null, values: refused ? planned.values : undefined,
        summary: refused && planned.summary ? planned.summary : undefined };
    });
  }

  /**
   * The plan of one candidate end. A line drawn without a kind yet (`relation.add` without `tool`: C mode, whose
   * chooser offers the kinds that fit the pair, spec §7.4) is possible when any of the three lines this design model
   * records is; when none is, the dependency's refusal says why (the line every pair of elements could have).
   */
  function plannedEnd(operation, context) {
    if (operation.op !== 'relation.add' || operation.tool) return plan(operation, context);
    const plans = RELATION_TOOLS.map((tool) => plan(Object.assign({}, operation, { tool: tool.id }), context));
    return plans.find((candidate) => candidate.kind !== 'refuse') || plans[RELATION_TOOLS.findIndex((tool) => tool.id === 'depend')];
  }

  // ---- What the view offers (spec §7.3, §5.6) -------------------------------------------------------------

  /** The palette: the element tools of the profile, the three lines this design model records, and the others as unavailable. */
  function tools(context) {
    const expert = context.profile === 'expert';
    return {
      elements: ELEMENT_TOOLS.filter((tool) => expert || tool.profile !== 'expert')
        .map((tool) => ({ id: tool.id, label: tool.label, glyph: tool.glyph, kind: tool.kind })),
      relations: RELATION_TOOLS.map((tool) => Object.assign({}, tool)),
      unavailable: UNAVAILABLE_TOOLS.map((tool) => Object.assign({}, tool)),
    };
  }

  /**
   * The option sets of the listbox (spec §7.3): "Code elements of ‹component›", "Outside ‹component›", and "Lines".
   * A set the drawing leaves empty is left out. Each description says in words what the drawing shows by its shape.
   */
  function optionSets(context) {
    const scope = scopeName(context);
    const kept = context.layout ? context.layout.positions : new Map();
    const boxes = context.viewModel.uml.classes.map((drawn) => ({ drawn, alias: aliasOf(drawn.id, context) })).filter((box) => box.alias);
    const boxOption = ({ drawn, alias }) => ({
      ref: alias, name: drawn.name,
      description: [drawn.lifted ? `${typeLine(context, drawn.id)}; outside ${scope}` : KIND_LINES[drawn.kind] || 'class']
        .concat(kept.has(drawn.id) ? ['position kept'] : []).join('; '),
    });
    const sets = [
      { id: 'code-elements', label: `Code elements of ${scope}`, options: boxes.filter((box) => !box.drawn.lifted).map(boxOption) },
      { id: 'outside', label: `Outside ${scope}`, options: boxes.filter((box) => box.drawn.lifted).map(boxOption) },
      { id: 'lines', label: 'Lines', options: drawnLines(context).map((line) => lineOption(line, context)) },
    ];
    return sets.filter((set) => set.options.length > 0);
  }

  function typeLine(context, id) {
    return TYPE_LINES[model(context).elements.get(id).type];
  }

  /** A line's option: named by its ends ("PrerequisiteRule implements EnrollmentRule"), described by its kind. */
  function lineOption(line, context) {
    const kind = LINE_KINDS[line.relation];
    if (INHERITANCE.has(line.relation)) {
      return { ref: `rel:${line.index}`, name: inheritancePhrase(context, line.modelFrom, line.relation, line.modelTo), description: `${kind}; routed for you` };
    }
    const declared = model(context).relationships.find((candidate) => candidate.id === line.relationshipId);
    const ends = ['source', 'target'].filter((end) => line.deep[end]).map((end) => (end === 'source'
      ? `starts at ${nameOf(context, line.modelFrom)} inside ${nameOf(context, line.from)}`
      : `ends at ${nameOf(context, line.modelTo)} inside ${nameOf(context, line.to)}`));
    return {
      ref: `rel:${line.index}`,
      name: siblings().shared.sentence(nameOf(context, line.modelFrom), declared ? declared.description : null, nameOf(context, line.modelTo), null),
      description: [kind].concat(ends).join('; '),
    };
  }

  /** Every drawn box can hold a position (spec §6 rule 1). */
  function holders(context) {
    return new Set(Object.keys(context.uml.ids));
  }

  /**
   * Why the box or line `ref` holds no layout, `{ code, values }`, or null: generalization and realization lines are
   * drawn as one tree per parent, and two dependencies in one direction between one pair of boxes share one key.
   */
  function layoutRefusal(ref, context) {
    if (typeof ref !== 'string' || !LINE_REF.test(ref)) return null;
    const line = lineOf(ref, context);
    if (INHERITANCE.has(line.relation)) return { code: 'layout/inheritance-line', values: {} };
    const parallel = drawnLines(context).filter((other) => other.relation === line.relation && other.from === line.from && other.to === line.to);
    return parallel.length > 1 ? { code: 'layout/parallel-lines', values: { A: nameOf(context, line.from), B: nameOf(context, line.to) } } : null;
  }

  /** The selection an option stands for: a box's element, a dependency's relationship; an inheritance line has none. */
  function selectionOf(ref, context) {
    if (typeof ref === 'string' && LINE_REF.test(ref)) {
      const line = lineOf(ref, context);
      return line.relationshipId ? { relationshipId: line.relationshipId } : null;
    }
    return Object.prototype.hasOwnProperty.call(context.uml.ids, ref) ? { elementId: context.uml.ids[ref] } : null;
  }

  /** The option a selection from the outline or a form stands for, or null when the drawing has none. */
  function refOf(selection, context) {
    if (!selection) return null;
    if (selection.relationshipId) {
      const line = drawnLines(context).find((candidate) => candidate.relationshipId === selection.relationshipId);
      return line ? `rel:${line.index}` : null;
    }
    return selection.elementId ? aliasOf(selection.elementId, context) : null;
  }

  const view = { notation: NOTATION, editable: true, optionSets, tools, plan, targets, holders, layoutRefusal, selectionOf, refOf };
  return view;
});
