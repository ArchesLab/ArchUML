(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-schema.js'), require('./c4-yaml.js'), require('./c4-edit-splices.js'),
      require('./c4-edit-results.js'), require('./c4-edit-references.js'));
  } else {
    var parts = root.ArchUMLC4Parts = root.ArchUMLC4Parts || {};
    parts.editSections = factory(parts.schema, parts.yaml, parts.editSplices, parts.editResults, parts.editReferences);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, yamlAdapter, splicesModule, resultsModule, referencesModule) {
  'use strict';

  // The edit commands of the design's sections beside the element tree (spec §4.8, §6.4): scenarios and their steps
  // and fragments, deployment environments, nodes, and node links, the entries of decisions, requirements, groups,
  // and views, the pinned positions of the layout and the layout parts of UML-notation views, and the schema header.
  // The module returns exactly its commands, keyed by `op`.

  const { createDraft, applyStep, draftEdits, removeAndPrune, removeAllAndPrune, pruneEmptied, listInsertion, writeFields, replaceEntry,
    ordered, withoutNulls, withoutEmptyList, writeRawValue, PLACEHOLDER, valueAt, isMap, hasOwn, fieldOf, startsWith } = splicesModule;
  const { umlLayoutView, deploymentLayoutPaths, deploymentPositionPaths, linkRoutePaths, nodeLayoutRenameEdits,
    withEmptiedLayoutParts } = referencesModule;
  const { refusal, unknownElement, finished, unknownFieldProblem, textProblem, optionalTextProblem, invalidIndex, isIndex, isText,
    connectorProblem } = resultsModule;

  const STEP_KEY_ORDER = schema.STEP_KEYS;
  // `steps` is the last key of a scenario (title, description, steps) and of a fragment branch (when, steps).
  const STEP_HOLDER_KEY_ORDER = ['title', 'description', 'when', 'steps'];
  const ENVIRONMENT_KEY_ORDER = ['name', 'description', 'nodes'];
  const NODE_KEY_ORDER = ['name', 'description', 'kind', 'technology', 'instances', 'hosts', 'nodes', 'collaborators', 'tags'];
  const NODE_UPDATES = ['name', 'description', 'kind', 'technology', 'instances', 'tags'];
  const MULTI_BRANCH_FRAGMENTS = ['alt', 'par'];
  const DEPLOYABLE_TYPES = ['container', 'system'];
  const TOP_LEVEL_SECTIONS = ['decisions', 'requirements', 'groups', 'views'];

  // ---- Scenarios (spec §4.8) -----------------------------------------------------------------
  //
  // A step list is named by the scenario and a `containerPath`: [] for the scenario's own steps, or the path of a
  // fragment branch from there, such as [2, 'alt', 0] or [1, 'opt'] (and [2, 'alt', 0, 'steps', 1, 'opt'] deeper).

  function addScenario(design, { title }) {
    const problem = textProblem('title', title);
    if (problem) return problem;
    const id = schema.uniqueId(schema.slugify(title, 'scenario'), new Set(design.model.scenarios.keys()));
    const edits = yamlAdapter.setEntry(design.parsed, ['scenarios'], id, { title }, { order: schema.TOP_LEVEL_KEYS });
    return finished(design.text, edits, { scenarioId: id });
  }

  /** Inserts a message step, as `"from -> to": description` unless it has more fields than those. */
  function addStep(design, { scenarioId, containerPath, index, step }) {
    const list = stepList(design, scenarioId, containerPath);
    if (list.error) return list;
    if (!isIndex(index, list.steps.length, { orEnd: true })) return invalidIndex(index);
    const problem = stepProblem(design, step, { partial: false });
    if (problem) return problem;
    const edits = listInsertion(design.parsed, list.holderPath, 'steps', index, stepValue(stepChanges(step)), STEP_HOLDER_KEY_ORDER);
    return finished(design.text, edits, { scenarioId, containerPath, index });
  }

  /**
   * Changes fields of a message step (null removes one). A shorthand step stays shorthand while it has only its ends
   * and a description; a step in the map form stays a map.
   */
  function updateStep(design, { scenarioId, containerPath, index, step: changes }) {
    const list = stepList(design, scenarioId, containerPath);
    if (list.error) return list;
    if (!isIndex(index, list.steps.length)) return invalidIndex(index);
    const problem = stepProblem(design, changes, { partial: true });
    if (problem) return problem;
    const current = list.steps[index];
    const keys = isMap(current) ? Object.keys(current) : [];
    if (keys.length === 0 || (keys.length === 1 && schema.FRAGMENTS.includes(keys[0]))) {
      return refusal('not-a-message-step', 'Only a message step has from, to, and a description');
    }
    const path = list.path.concat(index);
    const ends = keys.length === 1 ? schema.parseStepShorthand(keys[0]) : null;
    const draft = createDraft(design.text);
    if (ends) rewriteShorthandStep(draft, path, keys[0], Object.assign({}, ends, { description: current[keys[0]] }, stepChanges(changes)));
    else writeFields(draft, path, stepChanges(changes), STEP_KEY_ORDER);
    return finished(design.text, draftEdits(draft), { scenarioId, containerPath, index });
  }

  function rewriteShorthandStep(draft, path, key, step) {
    const value = stepValue(step);
    if (!isMap(value) || Object.keys(value).length !== 1) {
      replaceEntry(draft, path, value);
      return;
    }
    const [newKey] = Object.keys(value);
    if (newKey !== key) applyStep(draft, yamlAdapter.renameKey(draft.parsed, path, key, newKey));
    writeFields(draft, path, { [newKey]: value[newKey] }, []);
  }

  function removeStep(design, { scenarioId, containerPath, index }) {
    const list = stepList(design, scenarioId, containerPath);
    if (list.error) return list;
    if (!isIndex(index, list.steps.length)) return invalidIndex(index);
    const draft = createDraft(design.text);
    removeAndPrune(draft, list.path.concat(index));
    return finished(design.text, draftEdits(draft), { scenarioId });
  }

  /**
   * Moves the step or fragment at `from` of a step list to `to`. Within the list, `to` is its index after the move.
   * With `toContainerPath`, another step list, the step goes there, before the step at `to` (or at its end), and both
   * name places in the document as it is before the move; a fragment cannot go into one of its own branches.
   */
  function moveStep(design, { scenarioId, containerPath, from, to, toContainerPath = containerPath }) {
    const list = stepList(design, scenarioId, containerPath);
    if (list.error) return list;
    if (!isIndex(from, list.steps.length)) return invalidIndex(from);
    if (JSON.stringify(toContainerPath) === JSON.stringify(containerPath)) {
      if (!isIndex(to, list.steps.length)) return invalidIndex(to);
      return finished(design.text, yamlAdapter.moveItem(design.parsed, list.path, from, to), { scenarioId, containerPath, index: to });
    }
    const target = stepList(design, scenarioId, toContainerPath);
    if (target.error) return target;
    const stepPath = list.path.concat(from);
    if (startsWith(target.path, stepPath)) return refusal('fragment-into-itself', 'A fragment cannot be moved into one of its own branches');
    if (!isIndex(to, target.steps.length, { orEnd: true })) return invalidIndex(to);
    const draft = draftPlacing(design.text, (current, place) => {
      const step = writtenNode(current, stepPath);
      applyStep(current, listInsertion(current.parsed, target.holderPath, 'steps', to, PLACEHOLDER, STEP_HOLDER_KEY_ORDER));
      if (!place(target.path.concat(to), step)) return false;
      removeAndPrune(current, afterInsertion(stepPath, target.path, to));
      return true;
    });
    if (draft === null) return unwritableStep();
    const holderPath = afterRemoval(target.holderPath, stepPath);
    return finished(design.text, draftEdits(draft), { scenarioId, containerPath: containerPathOf(list, holderPath), index: to });
  }

  /** Inserts a fragment with one branch whose `when` is still empty: a list of branches for alt and par. */
  function addFragment(design, { scenarioId, containerPath, index, operator }) {
    const list = stepList(design, scenarioId, containerPath);
    if (list.error) return list;
    if (!isIndex(index, list.steps.length, { orEnd: true })) return invalidIndex(index);
    if (!schema.FRAGMENTS.includes(operator)) return invalidOperator();
    const branch = { when: '' };
    const value = { [operator]: MULTI_BRANCH_FRAGMENTS.includes(operator) ? [branch] : branch };
    const edits = listInsertion(design.parsed, list.holderPath, 'steps', index, value, STEP_HOLDER_KEY_ORDER);
    return finished(design.text, edits, { scenarioId, containerPath, index });
  }

  /**
   * `{ path, holderPath, steps, scenarioPath }` of the step list `containerPath` names (see above), or a refusal.
   * `path` is the YAML path of its `steps` key, `holderPath` that of the scenario or branch that holds it.
   */
  function stepList(design, scenarioId, containerPath) {
    const scenario = design.model.scenarios.get(scenarioId);
    if (!scenario) return refusal('unknown-scenario', `There is no scenario ${JSON.stringify(scenarioId)}`);
    const data = yamlAdapter.toData(design.parsed);
    const holderPath = Array.isArray(containerPath) && containerPath.length > 0
      ? scenario.path.concat('steps', containerPath) : scenario.path;
    const steps = valueAt(data, holderPath.concat('steps'));
    const isBranch = holderPath === scenario.path || (isMap(valueAt(data, holderPath)) && isBranchPath(containerPath));
    if (!Array.isArray(containerPath) || !isBranch || (steps != null && !Array.isArray(steps))) {
      return refusal('unknown-step-container', `Scenario ${scenarioId} has no step list at ${JSON.stringify(containerPath)}`);
    }
    return { path: holderPath.concat('steps'), holderPath, steps: steps || [], scenarioPath: scenario.path };
  }

  /** The container path (see above) of the step list held at `holderPath` in the scenario of `list`. */
  function containerPathOf(list, holderPath) {
    return holderPath.length === list.scenarioPath.length ? [] : holderPath.slice(list.scenarioPath.length + 1);
  }

  /** `path` as it reads once an item is inserted at `index` of the list at `listPath`: an index there at or after it moves down. */
  function afterInsertion(path, listPath, index) {
    const at = listPath.length;
    if (path.length <= at || !startsWith(path, listPath) || path[at] < index) return path;
    return path.slice(0, at).concat(path[at] + 1, path.slice(at + 1));
  }

  /** `path` as it reads once the item at `removed` is gone: an index after it in the same list moves up. */
  function afterRemoval(path, removed) {
    const at = removed.length - 1;
    if (path.length <= at || !startsWith(path, removed.slice(0, at)) || path[at] <= removed[at]) return path;
    return path.slice(0, at).concat(path[at] - 1, path.slice(at + 1));
  }

  /** Whether `containerPath` ends at a branch: `<op>` for opt, loop, and break, `<op>, <n>` for alt and par. */
  function isBranchPath(containerPath) {
    const last = containerPath[containerPath.length - 1];
    const operator = typeof last === 'number' ? containerPath[containerPath.length - 2] : last;
    return schema.FRAGMENTS.includes(operator) && MULTI_BRANCH_FRAGMENTS.includes(operator) === (typeof last === 'number');
  }

  function stepProblem(design, step, { partial }) {
    if (!isMap(step)) return refusal('invalid-step', 'A step is a map of from, to, description, technology, connector, and responsibility');
    // An update names only the ends it changes; a new step names both.
    const ends = ['from', 'to'].filter((key) => !partial || key in step);
    const unknownEnd = ends.find((key) => !design.model.elements.has(step[key]));
    if (unknownEnd) return unknownElement(step[unknownEnd]);
    return unknownFieldProblem(step, STEP_KEY_ORDER) || connectorProblem(step.connector) ||
      ['description', 'technology', 'responsibility'].map((key) => optionalTextProblem(key, step[key])).find(Boolean) || null;
  }

  /** Step fields as they are written: empty text leaves the field out. */
  function stepChanges(step) {
    const written = {};
    Object.entries(step).forEach(([key, value]) => { written[key] = value === '' ? null : value; });
    return written;
  }

  /** A step: `{ "from -> to": description }` when it has nothing else, otherwise the map form. */
  function stepValue(step) {
    const value = withoutNulls(ordered(step, STEP_KEY_ORDER));
    const keys = Object.keys(value);
    if (keys.length === 3 && 'description' in value) return { [`${value.from} -> ${value.to}`]: value.description };
    return value;
  }

  // ---- Fragments (UML-view editing spec §4.3) ------------------------------------------------
  //
  // A fragment's branches are named by their index: the items of an alt's or a par's list, and the one branch of an
  // opt, a loop, or a break, which is branch 0.

  /** Puts the consecutive steps `from` to `to` of a step list into the first branch of a new fragment, whose guard is still empty. */
  function wrapSteps(design, { scenarioId, containerPath, from, to, operator }) {
    const list = stepList(design, scenarioId, containerPath);
    if (list.error) return list;
    if (!isIndex(from, list.steps.length)) return invalidIndex(from);
    if (!isIndex(to, list.steps.length) || to < from) return invalidIndex(to);
    if (!schema.FRAGMENTS.includes(operator)) return invalidOperator();
    const stepPaths = Array.from({ length: to - from + 1 }, (unused, offset) => list.path.concat(from + offset));
    const branchSteps = list.path.concat(to + 1, operator, MULTI_BRANCH_FRAGMENTS.includes(operator) ? [0] : [], 'steps');
    const draft = draftPlacing(design.text, (current, place) => {
      const steps = stepPaths.map((path) => writtenNode(current, path));
      const branch = { when: '', steps: steps.map(() => PLACEHOLDER) };
      const value = { [operator]: MULTI_BRANCH_FRAGMENTS.includes(operator) ? [branch] : branch };
      applyStep(current, yamlAdapter.insertItem(current.parsed, list.path, to + 1, value));
      if (!steps.every((step, index) => place(branchSteps.concat(index), step))) return false;
      removeAllAndPrune(current, stepPaths);
      return true;
    });
    return draft === null ? unwritableStep() : finished(design.text, draftEdits(draft), { scenarioId, containerPath, index: from });
  }

  /** Replaces a fragment by the steps of its branches, in order. */
  function unwrapFragment(design, { scenarioId, containerPath, index }) {
    const fragment = fragmentAt(design, scenarioId, containerPath, index);
    if (fragment.error) return fragment;
    const { list } = fragment;
    const stepPaths = fragment.branches.flatMap((branch, number) => (Array.isArray(branch.steps) ? branch.steps : [])
      .map((step, stepIndex) => fragment.branchPaths[number].concat('steps', stepIndex)));
    const draft = draftPlacing(design.text, (current, place) => {
      const steps = stepPaths.map((path) => writtenNode(current, path));
      steps.forEach((step, offset) => applyStep(current, yamlAdapter.insertItem(current.parsed, list.path, index + 1 + offset, PLACEHOLDER)));
      if (!steps.every((step, offset) => place(list.path.concat(index + 1 + offset), step))) return false;
      removeAndPrune(current, fragment.path);
      return true;
    });
    return draft === null ? unwritableStep() : finished(design.text, draftEdits(draft), { scenarioId, containerPath, index });
  }

  /**
   * Gives a fragment another operator. Between alt and par, or among opt, loop, and break, only the keyword changes;
   * a fragment with one branch also changes between a list of branches and the branch itself.
   */
  function setFragmentOperator(design, { scenarioId, containerPath, index, operator }) {
    const fragment = fragmentAt(design, scenarioId, containerPath, index);
    if (fragment.error) return fragment;
    if (!schema.FRAGMENTS.includes(operator)) return invalidOperator();
    const selection = { scenarioId, containerPath, index };
    const multi = MULTI_BRANCH_FRAGMENTS.includes(operator);
    if (operator === fragment.operator) return finished(design.text, [], selection);
    if (multi === fragment.multi) {
      return finished(design.text, yamlAdapter.renameKey(design.parsed, fragment.path, fragment.operator, operator), selection);
    }
    if (!multi && fragment.branches.length > 1) return singleBranch(operator);
    const draft = draftPlacing(design.text, (current, place) => {
      const branch = writtenNode(current, fragment.branchPaths[0]);
      applyStep(current, yamlAdapter.renameKey(current.parsed, fragment.path, fragment.operator, operator));
      applyStep(current, yamlAdapter.setEntry(current.parsed, fragment.path, operator, multi ? [PLACEHOLDER] : PLACEHOLDER));
      return place(fragment.path.concat(operator, multi ? [0] : []), branch);
    });
    return draft === null ? unwritableStep() : finished(design.text, draftEdits(draft), selection);
  }

  /** Sets the guard of a branch; a guard is text. */
  function setBranchGuard(design, { scenarioId, containerPath, index, branch, when }) {
    const fragment = fragmentAt(design, scenarioId, containerPath, index);
    if (fragment.error) return fragment;
    if (!isIndex(branch, fragment.branches.length)) return invalidIndex(branch);
    if (!isText(when)) return emptyGuard();
    const edits = fragment.branches[branch].when === when ? []
      : yamlAdapter.setEntry(design.parsed, fragment.branchPaths[branch], 'when', when, { order: STEP_HOLDER_KEY_ORDER });
    return finished(design.text, edits, { scenarioId, containerPath, index });
  }

  /** Adds a branch with the guard `when` after the last branch of an alt or a par. */
  function addBranch(design, { scenarioId, containerPath, index, when }) {
    const fragment = fragmentAt(design, scenarioId, containerPath, index);
    if (fragment.error) return fragment;
    if (!fragment.multi) return singleBranch(fragment.operator);
    if (!isText(when)) return emptyGuard();
    const edits = yamlAdapter.appendItem(design.parsed, fragment.path.concat(fragment.operator), { when });
    return finished(design.text, edits, { scenarioId, containerPath, index });
  }

  /** Removes a branch with its steps; a fragment keeps at least one branch. */
  function removeBranch(design, { scenarioId, containerPath, index, branch }) {
    const fragment = fragmentAt(design, scenarioId, containerPath, index);
    if (fragment.error) return fragment;
    if (!isIndex(branch, fragment.branches.length)) return invalidIndex(branch);
    if (fragment.branches.length === 1) {
      return refusal('last-branch', 'This is the fragment\'s only branch; delete the fragment, or unwrap it to keep its steps');
    }
    const edits = yamlAdapter.deleteItem(design.parsed, fragment.path.concat(fragment.operator), branch);
    return finished(design.text, edits, { scenarioId, containerPath, index });
  }

  /**
   * The fragment at `index` of a step list, as written: `{ list, path, operator, multi, branches, branchPaths }`, or
   * a refusal for a message step and for a fragment not written with the branches its operator keeps.
   */
  function fragmentAt(design, scenarioId, containerPath, index) {
    const list = stepList(design, scenarioId, containerPath);
    if (list.error) return list;
    if (!isIndex(index, list.steps.length)) return invalidIndex(index);
    const keys = isMap(list.steps[index]) ? Object.keys(list.steps[index]) : [];
    if (keys.length !== 1 || !schema.FRAGMENTS.includes(keys[0])) {
      return refusal('not-a-fragment', `Step ${index + 1} of that step list is not a fragment`);
    }
    const [operator] = keys;
    const multi = MULTI_BRANCH_FRAGMENTS.includes(operator);
    const value = list.steps[index][operator];
    const branches = multi ? value : [value];
    if (!Array.isArray(branches) || branches.length === 0 || !branches.every(isMap)) {
      return refusal('invalid-fragment', `The ${operator} of step ${index + 1} is not written with ${multi ? 'a list of branches' : 'one branch'}; ` +
        'correct it in the YAML first');
    }
    const path = list.path.concat(index);
    const branchPaths = multi ? branches.map((branch, number) => path.concat(operator, number)) : [path.concat(operator)];
    return { list, path, operator, multi, branches, branchPaths };
  }

  function invalidOperator() {
    return refusal('invalid-operator', `A fragment is one of ${schema.FRAGMENTS.join(', ')}`);
  }

  function singleBranch(operator) {
    return refusal('single-branch', `${operator} has one branch; use alt for alternatives or par for branches that run at the same time`);
  }

  // The scenario form's sentence for a branch without a guard (c4-editor-inspector-scenarios.js shows it).
  function emptyGuard() {
    return refusal('empty-guard', 'Write the guard first: when does the branch run?');
  }

  function unwritableStep() {
    return refusal('invalid-step', 'A step to move holds an empty value, which cannot be written again; correct it in the YAML first');
  }

  // ---- Steps moved as written (spec §4.9) ----------------------------------------------------
  //
  // moveStep across step lists, wrapSteps, unwrapFragment, and setFragmentOperator between one branch and a list of
  // branches carry each step or branch to its new place as written, comments included, re-indented: a placeholder
  // marks where it goes, and its written text then takes the placeholder's place. Should one of them not read back as
  // the data it had (written text that a flow collection cannot take, say), the whole command writes every one of
  // them from its data instead, as moveEntry does.

  /**
   * The draft `build(draft, place)` writes, where `place(path, node)` puts a node captured by `writtenNode` over the
   * placeholder at `path` and says whether that worked, and `build` says whether every placement did: first as
   * written, otherwise from the data. Null when the data cannot be written either (it holds an empty value).
   */
  function draftPlacing(text, build) {
    const asWritten = createDraft(text);
    if (build(asWritten, (path, node) => placeAsWritten(asWritten, path, node))) return asWritten;
    const fromData = createDraft(text);
    try {
      build(fromData, (path, node) => {
        replaceEntry(fromData, path, node.data);
        return true;
      });
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
    }
    return fromData;
  }

  /** The node at `path` as written: `{ text, column, data }`, its text taking an inline comment after a flow node along. */
  function writtenNode(draft, path) {
    const range = yamlAdapter.rangeOf(draft.parsed, path, 'value');
    let text = draft.text.slice(range.offset, range.endOffset);
    // A block collection ends with its last line, comment included; a flow node or a scalar ends before its comment.
    const comment = /\n$/.test(text) ? null : /^[ \t]+#[^\r\n]*/.exec(draft.text.slice(range.endOffset));
    if (comment) text += comment[0];
    return { text: text.replace(/\s+$/, ''), column: range.start.col - 1, data: valueAt(yamlAdapter.toData(draft.parsed), path) };
  }

  /**
   * Puts `node` over the placeholder at `path`, its lines re-indented to the placeholder's column; a block collection
   * that becomes a map value starts on the next line, indented two columns past its key. True when the node then reads
   * back as the data it had.
   */
  function placeAsWritten(draft, path, node) {
    const range = yamlAdapter.rangeOf(draft.parsed, path, 'value');
    const isBlockCollection = (isMap(node.data) || Array.isArray(node.data)) && !/^[[{]/.test(node.text);
    const onNextLine = typeof path[path.length - 1] === 'string' && isBlockCollection;
    if (onNextLine && draft.text.charAt(range.offset - 1) !== ' ') return false;
    const column = onNextLine ? yamlAdapter.rangeOf(draft.parsed, path, 'key').start.col - 1 + 2 : range.start.col - 1;
    const text = reindented(node.text, column - node.column);
    if (text === null) return false;
    const start = onNextLine ? range.offset - 1 : range.offset;
    const written = onNextLine ? `${lineBreakOf(draft.text)}${' '.repeat(column)}${text}` : text;
    applyStep(draft, [{ offset: start, length: range.offset + PLACEHOLDER.length - start, text: written }]);
    if (draft.parsed.errors.length > 0) return false;
    return JSON.stringify(valueAt(yamlAdapter.toData(draft.parsed), path)) === JSON.stringify(node.data);
  }

  /**
   * `text` with each line after the first moved `shift` columns, blank lines as they are; null when a line other than a
   * comment would need to move further left than it is indented.
   */
  function reindented(text, shift) {
    const parts = text.split(/(\r?\n)/);
    for (let index = 2; index < parts.length; index += 2) {
      const line = parts[index];
      const indent = line.length - line.replace(/^ +/, '').length;
      if (line.trim() === '') continue;
      if (indent + shift < 0 && !line.trim().startsWith('#')) return null;
      parts[index] = ' '.repeat(Math.max(0, indent + shift)) + line.slice(indent);
    }
    return parts.join('');
  }

  function lineBreakOf(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
  }

  // ---- Deployment (spec §4.8) ----------------------------------------------------------------

  function addEnvironment(design, { name }) {
    const problem = textProblem('name', name);
    if (problem) return problem;
    const id = schema.uniqueId(schema.slugify(name, 'environment'), new Set(design.model.environments.keys()));
    const edits = yamlAdapter.setEntry(design.parsed, ['deployment'], id, { name }, { order: schema.TOP_LEVEL_KEYS });
    return finished(design.text, edits, { environmentId: id });
  }

  /** Adds a node to an environment, or inside `parentNodeId`; node ids are unique per environment. */
  function addNode(design, { environmentId, parentNodeId = null, kind = null, name }) {
    const environment = environmentOf(design, environmentId);
    if (environment.error) return environment;
    const parent = parentNodeId === null ? null : environment.nodes.get(parentNodeId);
    if (parentNodeId !== null && !parent) return unknownNode(environmentId, parentNodeId);
    if (parent && parent.kind === 'infrastructure') return infrastructureLeaf(parentNodeId);
    if (kind !== null && !schema.NODE_KINDS.includes(kind)) return refusal('invalid-kind', `A node kind is one of ${schema.NODE_KINDS.join(', ')}`);
    const problem = textProblem('name', name);
    if (problem) return problem;
    const id = schema.uniqueId(schema.slugify(name, 'node'), new Set(environment.nodes.keys()));
    const holder = parent ? parent.path : environment.path;
    const value = kind === null ? { name } : { name, kind };
    const edits = yamlAdapter.setEntry(design.parsed, holder.concat('nodes'), id, value,
      { order: parent ? NODE_KEY_ORDER : ENVIRONMENT_KEY_ORDER });
    return finished(design.text, edits, { environmentId, nodeId: id });
  }

  /** Sets one field of a node (null removes it); `hosts` and nested nodes have their own commands. */
  function updateNode(design, { environmentId, nodeId, field, value }) {
    const node = nodeOf(design, environmentId, nodeId);
    if (node.error) return node;
    if (!NODE_UPDATES.includes(field)) return refusal('invalid-field', `${JSON.stringify(field)} is not a field this command sets on a node`);
    const problem = nodeValueProblem(field, value);
    if (problem) return problem;
    const fields = valueAt(yamlAdapter.toData(design.parsed), node.path);
    if (field === 'kind' && value === 'infrastructure' && isMap(fields) && ('hosts' in fields || 'nodes' in fields)) {
      return infrastructureLeaf(nodeId);
    }
    const draft = createDraft(design.text);
    writeFields(draft, node.path, { [field]: withoutEmptyList(value) }, NODE_KEY_ORDER);
    return finished(design.text, draftEdits(draft), { environmentId, nodeId });
  }

  /** Removes a node with its nested nodes and the node collaborators of the environment that point at them. */
  function removeNode(design, { environmentId, nodeId }) {
    const node = nodeOf(design, environmentId, nodeId);
    if (node.error) return node;
    const environment = design.model.environments.get(environmentId);
    const removed = new Set();
    const visit = (id) => { removed.add(id); environment.nodes.get(id).childIds.forEach(visit); };
    visit(nodeId);
    const incoming = new Map();
    environment.nodes.forEach((source) => {
      if (removed.has(source.id)) return;
      source.relationships.filter((link) => removed.has(link.targetId)).forEach((link) => {
        const path = source.path.concat('collaborators', link.targetId);
        incoming.set(JSON.stringify(path), path);
      });
    });
    // The layout of the environment's deployment views loses the removed nodes' positions and the routes that end at
    // them or at what they host, so a node that later takes the id starts without a pin or a bend (spec §4.2).
    const data = yamlAdapter.toData(design.parsed);
    const layoutPaths = deploymentLayoutPaths(data, environmentId, { nodeIds: removed });
    const draft = createDraft(design.text);
    removeAllAndPrune(draft, withEmptiedLayoutParts(data, [...incoming.values(), node.path].concat(layoutPaths)));
    return finished(design.text, draftEdits(draft), { environmentId });
  }

  /** Sets the containers and software systems a node hosts; an empty list removes `hosts`. */
  function setHosts(design, { environmentId, nodeId, hosts }) {
    const node = nodeOf(design, environmentId, nodeId);
    if (node.error) return node;
    if (!Array.isArray(hosts) || !hosts.every(isText)) return refusal('invalid-value', 'hosts is a list of container and system ids');
    if (hosts.length > 0 && node.kind === 'infrastructure') return infrastructureLeaf(nodeId);
    for (const id of hosts) {
      const element = design.model.elements.get(id);
      if (!element) return unknownElement(id);
      if (!DEPLOYABLE_TYPES.includes(element.type)) {
        return refusal('invalid-host', `${id} is a ${element.type}; deployment nodes host containers and software systems`);
      }
    }
    // A host given up takes the bends of its instance's derived paths with it (spec §4.2).
    const data = yamlAdapter.toData(design.parsed);
    const dropped = new Set(node.hosts.filter((id) => !hosts.includes(id)).map((id) => `${id}@${nodeId}`));
    const draft = createDraft(design.text);
    writeFields(draft, node.path, { hosts: withoutEmptyList(hosts) }, NODE_KEY_ORDER);
    removeAllAndPrune(draft, withEmptiedLayoutParts(data, deploymentLayoutPaths(data, environmentId, { instanceKeys: dropped })));
    return finished(design.text, draftEdits(draft), { environmentId, nodeId });
  }

  /**
   * Puts a node, with the nodes inside it, into `newParentNodeId`, or at the top level for null. Going into a node, it
   * gives up its positions in the environment's deployment views, since only a top-level node holds one (UML-view
   * editing spec §4.2).
   */
  function moveNode(design, { environmentId, nodeId, newParentNodeId = null }) {
    const node = nodeOf(design, environmentId, nodeId);
    if (node.error) return node;
    const environment = design.model.environments.get(environmentId);
    const newParent = newParentNodeId === null ? null : environment.nodes.get(newParentNodeId);
    if (newParentNodeId !== null && !newParent) return unknownNode(environmentId, newParentNodeId);
    if (newParent && (newParentNodeId === nodeId || isNodeInside(environment, newParentNodeId, nodeId))) {
      return refusal('node-into-itself', `${nodeId} cannot be moved into itself or into a node inside it`);
    }
    if (newParent && newParent.kind === 'infrastructure') return infrastructureLeaf(newParentNodeId);
    const selection = { environmentId, nodeId };
    if (node.parentId === newParentNodeId) return finished(design.text, [], selection);
    const nodesMapOf = (parentId) => (parentId === null ? environment.path : environment.nodes.get(parentId).path).concat('nodes');
    const data = yamlAdapter.toData(design.parsed);
    const draft = createDraft(design.text);
    applyStep(draft, yamlAdapter.moveEntry(draft.parsed, nodesMapOf(node.parentId), nodeId, nodesMapOf(newParentNodeId),
      { order: newParent ? NODE_KEY_ORDER : ENVIRONMENT_KEY_ORDER }));
    pruneEmptied(draft, node.path);
    if (newParent) removeAllAndPrune(draft, withEmptiedLayoutParts(data, deploymentPositionPaths(data, environmentId, new Set([nodeId]))));
    return finished(design.text, draftEdits(draft), selection);
  }

  function isNodeInside(environment, nodeId, ancestorId) {
    for (let current = environment.nodes.get(nodeId).parentId; current !== null; current = environment.nodes.get(current).parentId) {
      if (current === ancestorId) return true;
    }
    return false;
  }

  /**
   * Adds the link from a node to another node of its environment (a node collaborator, spec §4.8), written as its
   * description alone, or as a map once it has a technology; empty text leaves a field out. With `replace`, it writes
   * over the link the node has to that node instead.
   */
  function setNodeLink(design, { environmentId, nodeId, targetNodeId, description = null, technology = null, replace = false }) {
    const link = nodeLinkOf(design, environmentId, nodeId, targetNodeId);
    if (link.error) return link;
    if (targetNodeId === nodeId) return refusal('link-self', `A link joins two different nodes; ${nodeId} cannot link to itself`);
    const problem = optionalTextProblem('description', description) || optionalTextProblem('technology', technology);
    if (problem) return problem;
    if (link.exists && !replace) return refusal('link-exists', `${nodeId} already has a link to ${targetNodeId}; edit that link`);
    if (!link.exists && replace) return unknownLink(nodeId, targetNodeId);
    const value = technology ? withoutNulls({ description: description || null, technology }) : description || '';
    const edits = yamlAdapter.setEntry(design.parsed, link.mapPath, targetNodeId, value, { order: NODE_KEY_ORDER });
    return finished(design.text, edits, { environmentId, nodeId });
  }

  /** Removes the link from a node to another node, with its stored bends in the environment's deployment views. */
  function removeNodeLink(design, { environmentId, nodeId, targetNodeId }) {
    const link = nodeLinkOf(design, environmentId, nodeId, targetNodeId);
    if (link.error) return link;
    if (!link.exists) return unknownLink(nodeId, targetNodeId);
    const data = yamlAdapter.toData(design.parsed);
    const paths = [link.mapPath.concat(targetNodeId)].concat(linkRoutePaths(data, environmentId, nodeId, targetNodeId));
    const draft = createDraft(design.text);
    removeAllAndPrune(draft, withEmptiedLayoutParts(data, paths));
    return finished(design.text, draftEdits(draft), { environmentId, nodeId });
  }

  /** `{ mapPath, exists }` of the link from a node to `targetNodeId`, both nodes of the environment, or a refusal. */
  function nodeLinkOf(design, environmentId, nodeId, targetNodeId) {
    const node = nodeOf(design, environmentId, nodeId);
    if (node.error) return node;
    const target = nodeOf(design, environmentId, targetNodeId);
    if (target.error) return target;
    const mapPath = node.path.concat('collaborators');
    const links = valueAt(yamlAdapter.toData(design.parsed), mapPath);
    return { mapPath, exists: isMap(links) && hasOwn(links, targetNodeId) };
  }

  function unknownLink(nodeId, targetNodeId) {
    return refusal('unknown-link', `${nodeId} has no link to ${targetNodeId}`);
  }

  /**
   * Gives a node a new id and rewrites what names it (UML-view editing spec §4.3, §14 D1): its key under `nodes`, the
   * link keys of the nodes of its environment, and its layout sites in the environment's deployment views. Node ids
   * are unique per environment.
   */
  function changeNodeId(design, { environmentId, nodeId, newId }) {
    const node = nodeOf(design, environmentId, nodeId);
    if (node.error) return node;
    if (newId === nodeId) return finished(design.text, [], { environmentId, nodeId });
    if (typeof newId !== 'string' || !schema.ID_PATTERN.test(newId)) {
      return refusal('invalid-id', 'Ids start with a letter and use letters, digits, - or _');
    }
    const environment = design.model.environments.get(environmentId);
    if (environment.nodes.has(newId)) return refusal('id-taken', `The id ${JSON.stringify(newId)} is already used`);
    const { parsed } = design;
    const data = yamlAdapter.toData(parsed);
    const edits = yamlAdapter.renameKey(parsed, node.path.slice(0, -1), nodeId, newId);
    environment.nodes.forEach((other) => {
      const links = fieldOf(valueAt(data, other.path), 'collaborators');
      if (isMap(links) && hasOwn(links, nodeId)) edits.push(...yamlAdapter.renameKey(parsed, other.path.concat('collaborators'), nodeId, newId));
    });
    edits.push(...nodeLayoutRenameEdits(parsed, environmentId, nodeId, newId));
    return finished(design.text, edits, { environmentId, nodeId: newId });
  }

  function environmentOf(design, environmentId) {
    const environment = design.model.environments.get(environmentId);
    return environment || refusal('unknown-environment', `There is no deployment environment ${JSON.stringify(environmentId)}`);
  }

  function nodeOf(design, environmentId, nodeId) {
    const environment = environmentOf(design, environmentId);
    if (environment.error) return environment;
    return environment.nodes.get(nodeId) || unknownNode(environmentId, nodeId);
  }

  function unknownNode(environmentId, nodeId) {
    return refusal('unknown-node', `The environment ${environmentId} has no node ${JSON.stringify(nodeId)}`);
  }

  function infrastructureLeaf(nodeId) {
    return refusal('infrastructure-leaf', `${nodeId} is infrastructure, such as a load balancer, which hosts nothing and holds no nodes`);
  }

  function nodeValueProblem(field, value) {
    if (value === null) return null;
    if (field === 'kind') return schema.NODE_KINDS.includes(value) ? null : refusal('invalid-kind', `A node kind is one of ${schema.NODE_KINDS.join(', ')}`);
    if (field === 'instances') return Number.isInteger(value) && value >= 1 ? null : refusal('invalid-value', 'instances is a whole number of at least 1');
    if (field === 'tags') return Array.isArray(value) && value.every(isText) ? null : refusal('invalid-value', 'tags is a list of texts');
    return textProblem(field, value);
  }

  // ---- Top-level entries ---------------------------------------------------------------------

  /** Writes the entry `id` of `decisions`, `requirements`, `groups`, or `views`, creating the section in canonical order. */
  function setTopLevelEntry(design, { section, id, value }) {
    if (!TOP_LEVEL_SECTIONS.includes(section)) return invalidSection(section);
    if (typeof id !== 'string' || !schema.ID_PATTERN.test(id)) return refusal('invalid-id', 'Ids start with a letter and use letters, digits, - or _');
    if (section === 'views' && schema.RESERVED_VIEW_IDS.includes(id)) return refusal('reserved-id', `${id} is the name of a built-in view`);
    if (!isText(value) && !isMap(value)) return refusal('invalid-value', `An entry of ${section} is a text or a map`);
    const edits = yamlAdapter.setEntry(design.parsed, [section], id, value, { order: schema.TOP_LEVEL_KEYS });
    return finished(design.text, edits, { section, id });
  }

  /** Removes an entry of a top-level section, and the section when it becomes empty. */
  function removeTopLevelEntry(design, { section, id }) {
    if (!TOP_LEVEL_SECTIONS.includes(section)) return invalidSection(section);
    const entries = valueAt(yamlAdapter.toData(design.parsed), [section]);
    if (!isMap(entries) || !hasOwn(entries, id)) return refusal('unknown-entry', `${section} has no entry ${JSON.stringify(id)}`);
    const draft = createDraft(design.text);
    removeAndPrune(draft, [section, id]);
    return finished(design.text, draftEdits(draft), null);
  }

  function invalidSection(section) {
    return refusal('invalid-section', `${JSON.stringify(section)} is not one of ${TOP_LEVEL_SECTIONS.join(', ')}`);
  }

  // ---- Layout and schema header (spec §4.8, §6.4) --------------------------------------------

  /**
   * Pins an element at `[x, y]` in a view's layout. A view without positions gets its canonical key (spec §4.10);
   * one whose key is written differently keeps that key.
   */
  function pinPosition(design, { viewKey, elementId, x, y }) {
    const layout = layoutEntry(design, viewKey);
    if (layout.error) return layout;
    const umlView = umlViewRefusal(design, layout.path);
    if (umlView) return umlView;
    if (!design.model.elements.has(elementId)) return unknownElement(elementId);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return refusal('invalid-position', 'A position is two finite numbers');
    const draft = createDraft(design.text);
    const path = layout.path.concat(elementId);
    if (valueAt(yamlAdapter.toData(draft.parsed), path) === undefined) {
      // A new list is written in block style; a position reads as `[x, y]`, so the entry is added with a scalar
      // that the flow list then replaces.
      applyStep(draft, yamlAdapter.setEntry(draft.parsed, layout.path, elementId, x, { order: schema.TOP_LEVEL_KEYS }));
      const range = yamlAdapter.rangeOf(draft.parsed, path, 'value');
      applyStep(draft, [{ offset: range.offset, length: range.endOffset - range.offset, text: yamlAdapter.stringifyFragment([x, y], { flow: true }) }]);
    } else {
      applyStep(draft, yamlAdapter.setEntry(draft.parsed, layout.path, elementId, [x, y]));
    }
    return finished(design.text, draftEdits(draft), { elementId });
  }

  /** Removes an element's pinned position, and the layout entry and section that this leaves empty. */
  function unpinPosition(design, { viewKey, elementId }) {
    const layout = layoutEntry(design, viewKey);
    if (layout.error) return layout;
    const umlView = umlViewRefusal(design, layout.path);
    if (umlView) return umlView;
    const path = layout.path.concat(elementId);
    if (valueAt(yamlAdapter.toData(design.parsed), path) === undefined) return finished(design.text, [], { elementId });
    const draft = createDraft(design.text);
    removeAndPrune(draft, path);
    return finished(design.text, draftEdits(draft), { elementId });
  }

  /**
   * `{ path }` of the layout entry for the view `viewKey` names, or a refusal for text that names no view. A view and
   * its annotated variants (`… with interfaces`) share one entry, keyed without the suffix (spec §4.8, §4.10).
   */
  function layoutEntry(design, viewKey) {
    const selector = schema.parseSelector(String(viewKey));
    if (selector.error) return refusal('invalid-view', selector.error);
    const key = schema.selectorKey(selector);
    const layout = valueAt(yamlAdapter.toData(design.parsed), ['layout']);
    const written = isMap(layout) ? Object.keys(layout).find((existing) => schema.selectorKey(existing) === key) : undefined;
    return { path: ['layout', written === undefined ? key : written] };
  }

  /** The refusal of pinPosition and unpinPosition for a view drawn in UML notation, whose layout has named parts; or null. */
  function umlViewRefusal(design, layoutPath) {
    const view = umlLayoutView(yamlAdapter.toData(design.parsed), layoutPath[1]);
    if (!view) return null;
    return refusal('layout/uml-view', `${layoutPath[1]} is drawn in UML notation; its layout holds ` +
      `${schema.UML_LAYOUT_PARTS[view.type].join(' and ')}, which setUmlLayout writes`);
  }

  // ---- Layout parts of UML-notation views (UML-view editing spec §4.2, §4.3) -----------------
  //
  // setUmlLayout writes the named parts of one view's layout entry as one splice. It reads the entry as written, plans
  // each part's change, and writes it key by key and item by item, so the text it does not change keeps its form and
  // its comments; a part, an entry, and a `layout` section left empty go too.

  // A missing `layout` section goes by the top-level order; a missing part goes before the parts that follow it.
  const LAYOUT_ORDER = schema.TOP_LEVEL_KEYS.concat(schema.LAYOUT_PART_ORDER);
  const UML_VIEW_NAMES = { code: 'a code view', deployment: 'a deployment view', interfaces: 'an interfaces view', dynamic: 'a dynamic view' };
  const INHERITANCE_RELATIONS = ['extends', 'implements'];

  /**
   * Writes the named parts of a UML-notation view's layout entry in one splice. A part left out is untouched, and a part
   * given as null is removed. `positions` merges by key (a key given as null is removed), `routes` merges by `from`,
   * `to`, and `relation` (an entry with `points: null` is removed), and `lifelines` replaces the list.
   */
  function setUmlLayout(design, { viewKey, positions, routes, lifelines }) {
    const given = { positions, routes, lifelines };
    const target = umlLayoutTarget(design, viewKey, given);
    if (target.error) return target;
    const problem = positionsProblem(design, target, positions) || routesProblem(design, target, routes) || lifelinesProblem(design, lifelines);
    if (problem) return problem;
    const draft = createDraft(design.text);
    writeUmlLayout(draft, target, given);
    return finished(design.text, draft.text === design.text ? [] : [yamlAdapter.differingSpan(design.text, draft.text)], null);
  }

  /**
   * The layout entry a UML view key names, as `{ path, type, scopeId, current }` with the entry as written (`current`,
   * a map), or a refusal: a key that names no UML-notation view, a part its view type lacks (`layout/part`), or an
   * entry or a given part that the YAML does not write as the view type has it.
   */
  function umlLayoutTarget(design, viewKey, given) {
    const layout = layoutEntry(design, viewKey);
    if (layout.error) return layout;
    const data = yamlAdapter.toData(design.parsed);
    const view = umlLayoutView(data, layout.path[1]);
    const parts = view ? schema.UML_LAYOUT_PARTS[view.type] : [];
    const lacking = schema.LAYOUT_PART_ORDER.find((part) => given[part] !== undefined && !parts.includes(part));
    if (lacking) {
      return refusal('layout/part', view ? `The layout of ${UML_VIEW_NAMES[view.type]} keeps no ${lacking}; it keeps ${parts.join(' and ')}`
        : `${layout.path[1]} is not drawn in UML notation; pinPosition keeps the positions of a C4 view`);
    }
    const current = valueAt(data, layout.path);
    const shapes = { positions: isMap, routes: Array.isArray, lifelines: Array.isArray };
    const malformed = (current != null && !isMap(current)) || (isMap(current) && schema.LAYOUT_PART_ORDER.some((part) =>
      given[part] !== undefined && current[part] != null && !shapes[part](current[part])));
    if (malformed) return refusal('invalid-layout', `The layout of ${layout.path[1]} is not written as its view keeps it; correct it in the YAML first`);
    return { path: layout.path, type: view && view.type, scopeId: view && view.scopeId, current: current || {} };
  }

  function isPoint(value) {
    return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  }

  function invalidPosition() {
    return refusal('invalid-position', 'A position is two finite numbers');
  }

  /** What is wrong with the given positions, or null: a malformed position, or a key that cannot hold one. */
  function positionsProblem(design, target, positions) {
    if (positions == null) return null;
    if (!isMap(positions)) return refusal('invalid-value', 'positions is a map from id to [x, y]');
    for (const [id, point] of Object.entries(positions)) {
      if (point === null) continue;
      if (!isPoint(point)) return invalidPosition();
      const problem = target.type === 'deployment' ? nodePositionProblem(design, target.scopeId, id)
        : (design.model.elements.has(id) ? null : unknownElement(id));
      if (problem) return problem;
    }
    return null;
  }

  /** Only a top-level node holds a position: a nested node and a hosted instance are laid out inside their node. */
  function nodePositionProblem(design, environmentId, id) {
    const environment = environmentOf(design, environmentId);
    if (environment.error) return environment;
    const node = environment.nodes.get(id);
    if (node && node.parentId === null) return null;
    if (node) return refusal('layout/inside-node', `${id} is inside ${node.parentId}; only a top-level node holds a position`);
    const hosted = referencesModule.instanceKeyParts(id) || [...environment.nodes.values()].some((candidate) => candidate.hosts.includes(id));
    return hosted ? refusal('layout/inside-node', `${id} runs on a node; what is inside a node is laid out inside it`) : unknownNode(environmentId, id);
  }

  /** What is wrong with the given routes, or null. */
  function routesProblem(design, target, routes) {
    if (routes == null) return null;
    if (!Array.isArray(routes)) return refusal('invalid-value', 'routes is a list of routes { from, to, relation, points }');
    for (const route of routes) {
      if (!isMap(route) || !isText(route.from) || !isText(route.to) || !isText(route.relation)) {
        return refusal('invalid-value', 'A route is { from, to, relation, points }');
      }
      if (target.type === 'code' && INHERITANCE_RELATIONS.includes(route.relation)) {
        return refusal('layout/inheritance-line', 'Generalization and realization lines are drawn as one tree for each parent and keep no route');
      }
      const relations = schema.ROUTE_RELATIONS[target.type];
      if (!relations.includes(route.relation)) {
        return refusal('invalid-relation', `A route of ${UML_VIEW_NAMES[target.type]} is a ${relations.join(' or a ')}`);
      }
      if (route.points === null) continue;
      if (!Array.isArray(route.points) || route.points.length < 2) return refusal('invalid-route', 'A route has at least two points');
      if (!route.points.every(isPoint)) return invalidPosition();
      const problem = [route.from, route.to].map((end) => routeEndProblem(design, target, route.relation, end)).find(Boolean);
      if (problem) return problem;
    }
    return null;
  }

  /** A route ends at an element in a code view, at a node on a link, and at an instance key `<element>@<node>` on a derived path. */
  function routeEndProblem(design, target, relation, end) {
    if (target.type === 'code') return design.model.elements.has(end) ? null : unknownElement(end);
    const environment = environmentOf(design, target.scopeId);
    if (environment.error) return environment;
    if (relation === 'link') return environment.nodes.has(end) ? null : unknownNode(target.scopeId, end);
    const instance = referencesModule.instanceKeyParts(end);
    if (!instance) return refusal('invalid-value', `A derived path ends at an instance key <element>@<node>, not ${JSON.stringify(end)}`);
    if (!environment.nodes.has(instance.nodeId)) return unknownNode(target.scopeId, instance.nodeId);
    return design.model.elements.has(instance.elementId) ? null : unknownElement(instance.elementId);
  }

  function lifelinesProblem(design, lifelines) {
    if (lifelines == null) return null;
    if (!Array.isArray(lifelines) || !lifelines.every(isText)) return refusal('invalid-value', 'lifelines is a list of element ids');
    const unknown = lifelines.find((id) => !design.model.elements.has(id));
    return unknown === undefined ? null : unknownElement(unknown);
  }

  /** `{ replaced: [[index, points]], removed: [index], added: [route] }` against the routes as written. */
  function routePlan(written, given) {
    const byKey = new Map(given.map((route) => [JSON.stringify([route.from, route.to, route.relation]), route]));
    const plan = { replaced: [], removed: [], added: [] };
    byKey.forEach((route) => {
      const index = written.findIndex((item) => isMap(item) && item.from === route.from && item.to === route.to && item.relation === route.relation);
      if (route.points === null) {
        if (index >= 0) plan.removed.push(index);
      } else if (index >= 0) plan.replaced.push([index, route.points]);
      else plan.added.push({ from: route.from, to: route.to, relation: route.relation, points: route.points });
    });
    return plan;
  }

  /** How many entries each part has once the given parts are written; untouched parts as written. */
  function partSizes(current, given) {
    const size = (value) => (Array.isArray(value) ? value.length : isMap(value) ? Object.keys(value).length : 0);
    const positions = given.positions === undefined ? size(current.positions) : given.positions === null ? 0
      : Object.keys(Object.assign({}, isMap(current.positions) ? current.positions : {}, given.positions))
        .filter((id) => !(hasOwn(given.positions, id) && given.positions[id] === null)).length;
    const written = Array.isArray(current.routes) ? current.routes : [];
    const plan = given.routes == null ? null : routePlan(written, given.routes);
    const routes = given.routes === undefined ? size(current.routes) : plan === null ? 0 : written.length - plan.removed.length + plan.added.length;
    const lifelines = given.lifelines === undefined ? size(current.lifelines) : size(given.lifelines);
    return { positions, routes, lifelines };
  }

  /** Writes the given parts into the draft; removes a part, the entry, and the section that are left empty. */
  function writeUmlLayout(draft, target, given) {
    const { current, path } = target;
    const sizes = partSizes(current, given);
    const keepsOther = Object.keys(current).some((key) => !schema.LAYOUT_PART_ORDER.includes(key));
    if (!keepsOther && schema.LAYOUT_PART_ORDER.every((part) => sizes[part] === 0)) {
      if (valueAt(yamlAdapter.toData(draft.parsed), path) !== undefined) removeAndPrune(draft, path);
      return;
    }
    const writers = { positions: writePositions, routes: writeRoutes, lifelines: writeLifelines };
    schema.LAYOUT_PART_ORDER.filter((part) => given[part] !== undefined).forEach((part) => {
      if (sizes[part] > 0) writers[part](draft, path, given[part]);
      else if (hasOwn(valueAt(yamlAdapter.toData(draft.parsed), path) || {}, part)) applyStep(draft, yamlAdapter.deleteEntry(draft.parsed, path, part));
    });
  }

  const flowText = (value) => yamlAdapter.stringifyFragment(value, { flow: true });

  function writePositions(draft, entryPath, positions) {
    const path = entryPath.concat('positions');
    Object.entries(positions).forEach(([id, point]) => {
      const written = valueAt(yamlAdapter.toData(draft.parsed), path.concat(id));
      if (point === null) {
        if (written !== undefined) applyStep(draft, yamlAdapter.deleteEntry(draft.parsed, path, id));
      } else if (written === undefined) {
        writeRawValue(draft, path, id, flowText(point), LAYOUT_ORDER);
      } else if (!(Array.isArray(written) && written.length === 2 && written.every((value, index) => Number(value) === point[index]))) {
        applyStep(draft, yamlAdapter.setEntry(draft.parsed, path, id, point));
      }
    });
  }

  function writeRoutes(draft, entryPath, routes) {
    const path = entryPath.concat('routes');
    const written = valueAt(yamlAdapter.toData(draft.parsed), path);
    const plan = routePlan(Array.isArray(written) ? written : [], routes);
    // Points first, then removals from the end, then additions: no step moves an index a later one uses.
    plan.replaced.forEach(([index, points]) => writeRawValue(draft, path.concat(index), 'points', flowText(points), schema.ROUTE_KEYS));
    plan.removed.sort((a, b) => b - a).forEach((index) => applyStep(draft, yamlAdapter.deleteItem(draft.parsed, path, index)));
    plan.added.forEach((route) => appendRoute(draft, entryPath, route));
  }

  /** Adds a route as a flow map, the last item of a block list that is created when the entry has no routes yet. */
  function appendRoute(draft, entryPath, route) {
    const path = entryPath.concat('routes');
    const written = valueAt(yamlAdapter.toData(draft.parsed), path);
    const index = Array.isArray(written) ? written.length : 0;
    if (index > 0) applyStep(draft, yamlAdapter.appendItem(draft.parsed, path, PLACEHOLDER));
    else applyStep(draft, yamlAdapter.setEntry(draft.parsed, entryPath, 'routes', [PLACEHOLDER], { order: LAYOUT_ORDER }));
    const range = yamlAdapter.rangeOf(draft.parsed, path.concat(index), 'value');
    applyStep(draft, [{ offset: range.offset, length: range.endOffset - range.offset, text: flowText(route) }]);
  }

  function writeLifelines(draft, entryPath, lifelines) {
    const written = valueAt(yamlAdapter.toData(draft.parsed), entryPath.concat('lifelines'));
    if (JSON.stringify(written) !== JSON.stringify(lifelines)) writeRawValue(draft, entryPath, 'lifelines', flowText(lifelines), LAYOUT_ORDER);
  }

  /** Writes `schema: c4-design/1` as the first key, below the comments that open the file, unless `schema` is set. */
  function ensureSchemaHeader(design) {
    const data = yamlAdapter.toData(design.parsed);
    if (data !== null && !isMap(data)) return refusal('invalid-document', 'A design is a map of top-level keys');
    if (data !== null && hasOwn(data, 'schema')) return finished(design.text, [], null);
    const order = ['schema'].concat(Object.keys(data || {}));
    return finished(design.text, yamlAdapter.setEntry(design.parsed, [], 'schema', schema.SCHEMA_VERSION, { order }), null);
  }

  return {
    addScenario, addStep, updateStep, removeStep, moveStep, addFragment, wrapSteps, unwrapFragment, setFragmentOperator,
    setBranchGuard, addBranch, removeBranch, addEnvironment, addNode, updateNode, removeNode, setHosts, moveNode, setNodeLink,
    removeNodeLink, changeNodeId, setTopLevelEntry, removeTopLevelEntry, pinPosition, unpinPosition, setUmlLayout, ensureSchemaHeader,
  };
});
