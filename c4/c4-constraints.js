(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-schema.js'), require('./c4-projection.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.constraints = factory(parts.schema, parts.projection);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, projection) {
  'use strict';

  // Rules that the editor's forms and its UML-view canvases must answer alike, so each has one owner here (UML-view
  // editing spec §4.3): containment, the ends a scenario step may have at a position of a step list, and which code
  // element may extend or implement which. Every function reads a model; the facade (c4-core.js) answers for designs.

  // ---- Containment ---------------------------------------------------------------------------

  /** Whether `id` lies inside `ancestorId`, at any depth; an element is not inside itself. */
  function isInside(model, id, ancestorId) {
    for (let current = model.elements.get(id); current && current.parentId !== null; current = model.elements.get(current.parentId)) {
      if (current.parentId === ancestorId) return true;
    }
    return false;
  }

  /** Whether one of the two elements is inside the other. */
  function isNested(model, a, b) {
    return isInside(model, a, b) || isInside(model, b, a);
  }

  // ---- Scenario steps (C4 spec §6.3) ---------------------------------------------------------

  // The `classifySteps` statuses of a step that runs along a relationship: valid wherever it stands.
  const ALONG_RELATIONSHIP = ['forward', 'async'];

  /** The step list that `containerPath` names in a step tree (the model's steps or `classifySteps`, which mirrors them). */
  function stepListAt(steps, containerPath) {
    let list = steps;
    let at = 0;
    while (at < containerPath.length) {
      const operator = containerPath[at + 1];
      const multi = schema.MULTI_BRANCH_FRAGMENTS.includes(operator);
      list = list[containerPath[at]].branches[multi ? containerPath[at + 2] : 0].steps;
      at += multi ? 3 : 2;
      if (containerPath[at] === 'steps') at += 1;
    }
    return list;
  }

  /** A copy of the step tree with `inserted` (a list of steps) at (or, with `replace`, in place of the step at) `index` of that list. */
  function withStepsAt(steps, containerPath, index, inserted, replace) {
    if (containerPath.length === 0) {
      const next = steps.slice();
      next.splice(index, replace ? 1 : 0, ...inserted);
      return next;
    }
    const [fragmentIndex, operator] = containerPath;
    const multi = schema.MULTI_BRANCH_FRAGMENTS.includes(operator);
    const branchIndex = multi ? containerPath[2] : 0;
    let rest = containerPath.slice(multi ? 3 : 2);
    if (rest[0] === 'steps') rest = rest.slice(1);
    const fragment = steps[fragmentIndex];
    const branches = fragment.branches.map((branch, position) => (position === branchIndex
      ? Object.assign({}, branch, { steps: withStepsAt(branch.steps, rest, index, inserted, replace) }) : branch));
    const next = steps.slice();
    next[fragmentIndex] = Object.assign({}, fragment, { branches });
    return next;
  }

  /**
   * Element pairs a step could run between: along a relationship, or back along it as a reply, between the ends or
   * their ancestors (`classifySteps` accepts steps between enclosing elements), never between an element and its own
   * part. In the model's relationship order.
   */
  const pairsByModel = new WeakMap();

  function candidatePairs(model) {
    if (!pairsByModel.has(model)) pairsByModel.set(model, structuralPairs(model));
    return pairsByModel.get(model);
  }

  function structuralPairs(model) {
    const lineage = (id) => {
      const chain = [];
      for (let current = model.elements.get(id); current; current = current.parentId ? model.elements.get(current.parentId) : null) chain.push(current.id);
      return chain;
    };
    const pairs = new Set();
    model.relationships.forEach((relationship) => lineage(relationship.sourceId).forEach((source) => lineage(relationship.targetId).forEach((target) => {
      if (source === target || isNested(model, source, target)) return;
      pairs.add(`${source}\n${target}`);
      pairs.add(`${target}\n${source}`);
    })));
    return [...pairs].map((pair) => pair.split('\n'));
  }

  /** A message step from `from` to `to` with nothing else set, as the model holds it: a candidate to classify. */
  function trialStep([from, to]) {
    return { kind: 'message', from, to, description: null, technology: null, connector: null, responsibility: null, uses: null, path: [] };
  }

  const pairKey = (from, to) => `${from}\n${to}`;

  /**
   * The ends of a step at `index` of the step list `containerPath` names in scenario `scenarioId` (in place of the
   * step there with `replace`) that `classifySteps` does not call invalid, so a reply is offered only where an earlier
   * request is still open. With `sender`, only the pairs from that sender are offered. Returns `{ froms, tosOf(from),
   * problemOf(from, to) }` with ids in the model's element order; `problemOf` gives null for an offered pair, else
   * why the pair cannot be a step there: `unknown-element`, `same-element`, `nested-ends`, or the step's `reasonCode`
   * (`no-relationship`, `reply-without-request`, `asynchronous-no-reply`). For a scenario the model does not have
   * nothing is offered, and every pair is `unknown-element`.
   *
   * Two classifications per position, whatever the model's size (spec §9.2): the candidates are tried as a run of steps
   * at `index` in a copy of the scenario. Spec §6.3 makes a step along a relationship (forward or async) valid wherever
   * it stands, and a step against one depend only on the requests open before it; only a forward step opens a request,
   * and each candidate pair can answer only its own. So the first run settles the steps along relationships, and a
   * second run of the remaining candidates alone, which open nothing, classifies each as if it stood at `index` by itself.
   * `problemOf` classifies a pair that neither run tried (another sender's) the same way, alone at `index`. Since a
   * step is judged only by the steps before it, `replace` changes no answer; it is accepted as the forms pass it.
   */
  function stepEnds(model, { scenarioId, containerPath = [], index, replace = false, sender = null }) {
    const scenario = model.scenarios.get(scenarioId);
    if (!scenario) return noStepEnds();
    const classifiedAt = (pairs) => {
      const trial = Object.assign({}, scenario, { steps: withStepsAt(scenario.steps, containerPath, index, pairs.map(trialStep), replace) });
      const trialModel = Object.assign({}, model, { scenarios: new Map(model.scenarios).set(scenario.id, trial) });
      return stepListAt(projection.classifySteps(trialModel, scenario.id), containerPath).slice(index, index + pairs.length);
    };
    const candidates = candidatePairs(model).filter(([from]) => sender === null || from === sender);
    const firstRun = candidates.length > 0 ? classifiedAt(candidates).map((classified) => classified.status) : [];
    const along = candidates.filter((pair, position) => ALONG_RELATIONSHIP.includes(firstRun[position]));
    const against = candidates.filter((pair, position) => !ALONG_RELATIONSHIP.includes(firstRun[position]));
    const secondRun = against.length > 0 ? classifiedAt(against) : [];
    // The reason code of each tried pair: null along a relationship, the second run's code against one.
    const problems = new Map(along.map(([from, to]) => [pairKey(from, to), null]));
    against.forEach(([from, to], position) => problems.set(pairKey(from, to), reasonOf(secondRun[position])));
    const receivers = new Map();
    problems.forEach((problem, key) => {
      if (problem !== null) return;
      const [from, to] = key.split('\n');
      if (!receivers.has(from)) receivers.set(from, new Set());
      receivers.get(from).add(to);
    });
    const order = [...model.elements.keys()];
    return {
      froms: order.filter((id) => receivers.has(id)),
      tosOf: (from) => order.filter((id) => receivers.has(from) && receivers.get(from).has(id)),
      problemOf: (from, to) => {
        if (!model.elements.has(from) || !model.elements.has(to)) return 'unknown-element';
        if (from === to) return 'same-element';
        if (isNested(model, from, to)) return 'nested-ends';
        const key = pairKey(from, to);
        if (!problems.has(key)) problems.set(key, reasonOf(classifiedAt([[from, to]])[0]));
        return problems.get(key);
      },
    };
  }

  /** The reason code of a classified step: null for a valid one (and for a position beyond the list, as before). */
  function reasonOf(classified) {
    return classified && classified.status === 'invalid' ? classified.reasonCode : null;
  }

  /** The answer where no step can be placed: no ends, and every pair is `unknown-element`. */
  function noStepEnds() {
    return { froms: [], tosOf: () => [], problemOf: () => 'unknown-element' };
  }

  /** Every element that sends or answers along some relationship: the sender choices of an existing step. */
  function structuralSenders(model) {
    const senders = new Set(candidatePairs(model).map(([from]) => from));
    return [...model.elements.keys()].filter((id) => senders.has(id));
  }

  // ---- Generalization and realization between code elements -----------------------------------

  // The kind rule (UML-view editing spec §4.3): a class or an abstract class extends a class or an abstract class; an
  // interface extends an interface; a class, an abstract class, or an enum implements an interface; a function and a
  // module extend and implement nothing.
  const EXTENDABLE_KINDS = { class: ['class', 'abstract_class'], abstract_class: ['class', 'abstract_class'], interface: ['interface'] };
  const IMPLEMENTING_KINDS = ['class', 'abstract_class', 'enum'];
  const INHERITANCE_RELATIONS = ['extends', 'implements'];

  /**
   * Why `sourceId` cannot `extends` or `implements` `targetId` (`relation`), or null: `extends-target` when the
   * target is not a code element of the model, `implements-target` when an implemented target is not an interface,
   * `extends-kind` when the kind rule forbids the source's kind that relation to the target's kind (a source that is not
   * a code element has no kind that may), and `extends-cycle` when the target already extends the source, directly or
   * through others, or is the source.
   */
  function inheritanceProblem(model, sourceId, relation, targetId) {
    if (!INHERITANCE_RELATIONS.includes(relation)) throw new Error(`inheritanceProblem: ${relation} is neither extends nor implements`);
    const target = model.elements.get(targetId);
    if (!target || target.type !== 'code') return 'extends-target';
    const source = model.elements.get(sourceId);
    const sourceKind = source && source.type === 'code' ? source.kind : null;
    if (relation === 'implements') {
      if (target.kind !== 'interface') return 'implements-target';
      return IMPLEMENTING_KINDS.includes(sourceKind) ? null : 'extends-kind';
    }
    if (!(EXTENDABLE_KINDS[sourceKind] || []).includes(target.kind)) return 'extends-kind';
    return extendsReaches(model, targetId, sourceId) ? 'extends-cycle' : null;
  }

  /** Whether `goalId` is `fromId` or an element `fromId` extends, directly or through others. */
  function extendsReaches(model, fromId, goalId) {
    const seen = new Set();
    const pending = [fromId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === goalId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const element = model.elements.get(id);
      if (element && element.code) pending.push(...element.code.extends);
    }
    return false;
  }

  return { isInside, isNested, stepEnds, noStepEnds, structuralSenders, inheritanceProblem };
});
