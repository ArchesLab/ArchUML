'use strict';

// toUml gives every UML-notation view an `ids` map and a source map, keeps its aliases clear of the words the ArchUML
// grammar reads at the start of a line, and positionForAnchor maps an insertion anchor to a step position (UML-view
// editing spec §4.1). The text is read with the bundle's own parsers, loaded as uml.test.js loads them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadCore, fixture } = require('./helpers.js');
const { UML_ALIAS_KEYWORDS } = require('../../c4/c4-uml.js');

const core = loadCore();

const sandbox = { document: { readyState: 'loading', addEventListener() {}, documentElement: {} }, MutationObserver: class { observe() {} } };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../uml-bundle.js'), 'utf8'), sandbox);

const PARSERS = { class: 'UMLClassDiagram', sequence: 'UMLSequenceDiagram', deployment: 'UMLDeploymentDiagram', component: 'UMLComponentDiagram' };
/** The bundle's parse of a toUml result; a JSON round trip makes the sandbox's values comparable with local ones. */
const parse = (uml) => JSON.parse(JSON.stringify(sandbox[PARSERS[uml.type]].parse(uml.text)));

const EDITING = fixture('uml-editing.yml');
const INTERFACES = fixture('course-registration-interfaces.yml');
const load = (text) => core.load(text, { source: 'file' });
const editing = load(EDITING);
const interfaces = load(INTERFACES);

/** A view and its toUml result. */
function drawn(design, selector) {
  const viewModel = core.project(design, selector);
  return { design, selector, viewModel, uml: core.toUml(viewModel) };
}

// Lifted boxes and colliding names (code), hidden steps and nested fragments (dynamic), an element on two hosts
// (deployment), and balls and sockets (interfaces).
const VIEWS = [
  [editing, 'code of policy'], [editing, 'code of seats'], [editing, 'dynamic enroll'], [editing, 'dynamic probe'],
  [editing, 'deployment production'], [interfaces, 'interfaces of api'],
];

/** `text` with `from` replaced by `to`; `from` must occur. */
function replaced(text, from, to) {
  assert.ok(text.includes(from), `${from} is in the fixture`);
  return text.replace(from, to);
}

function isSameOrInside(model, id, ancestorId) {
  for (let element = model.elements.get(id); element; element = model.elements.get(element.parentId)) {
    if (element.id === ancestorId) return true;
  }
  return false;
}

/** `[index, operator, branch?]` segments of a container path in the scenario commands' form. */
function segmentsOf(containerPath) {
  const segments = [];
  containerPath.forEach((part, position) => {
    if (position === 0 || part === 'steps') segments.push([]);
    if (part !== 'steps') segments[segments.length - 1].push(part);
  });
  return segments;
}

/** The step (or step status) at `{ containerPath, index }` of a step tree; both trees nest as `branches[b].steps`. */
function itemAt(steps, { containerPath, index }) {
  const list = segmentsOf(containerPath).reduce((current, [at, , branch = 0]) => current[at].branches[branch].steps, steps);
  return list[index];
}

// ---- ids --------------------------------------------------------------------------------------

/** The aliases the bundle reads from a text: declared names and every name a relation, message, or link uses. */
const ALIASES_READ = {
  class: (parsed) => parsed.classes.map((entry) => entry.name).concat(parsed.relationships.flatMap((relation) => [relation.from, relation.to])),
  sequence: (parsed) => parsed.participants.map((participant) => participant.id),
  deployment: (parsed) => parsed.elements.map((element) => element.name),
  component: (parsed) => parsed.components.flatMap((component) => [component.name].concat(component.ports.map((port) => port.alias)))
    .concat(parsed.connectors.flatMap((connector) => [connector.from, connector.fromPort, connector.to, connector.toPort])),
};

/** Whether an `ids` value names a thing of the model the view draws. */
const NAMES_MODEL_THING = {
  class: ({ design }, value) => design.model.elements.has(value),
  sequence: ({ design }, value) => design.model.elements.has(value),
  deployment: ({ design, viewModel }, value) => {
    const nodes = design.model.environments.get(viewModel.scopeId).nodes;
    const [elementId, nodeId] = value.split('@');
    return nodeId === undefined ? nodes.has(value) : nodes.has(nodeId) && nodes.get(nodeId).hosts.includes(elementId);
  },
  component: ({ design }, value) => design.model.elements.has(value) || design.model.interfaces.has(value),
};

test('every alias in the text is a key of ids, for all four view types', () => {
  const types = VIEWS.map(([design, selector]) => {
    const view = drawn(design, selector);
    const { uml } = view;
    assert.deepEqual(Object.keys(uml.ids).sort(), [...new Set(ALIASES_READ[uml.type](parse(uml)))].sort(),
      `${selector}: the keys of ids are the aliases the text uses`);
    Object.entries(uml.ids).forEach(([alias, value]) =>
      assert.ok(NAMES_MODEL_THING[uml.type](view, value), `${selector}: ${alias} stands for ${value}, a thing of the model`));
    return uml.type;
  });
  assert.deepEqual([...new Set(types)].sort(), ['class', 'component', 'deployment', 'sequence']);
});

test('an instance alias stands for its element on its node, also for an element hosted once', () => {
  const { ids } = drawn(editing, 'deployment production').uml;
  assert.deepEqual([ids.web, ids.api_api_pod, ids.api_canary, ids.api_pod], ['web@browser', 'api@api-pod', 'api@canary', 'api-pod']);
});

test('classes named "Seat Holds" and "Seat_Holds" are drawn as Seat_Holds and Seat_Holds_2, and ids maps each alias to its own element', () => {
  const { uml } = drawn(editing, 'code of policy');
  assert.deepEqual([uml.ids.Seat_Holds, uml.ids.Seat_Holds_2], ['SeatHolds', 'SeatHoldRows']);
  const lines = uml.text.split('\n');
  const declared = (head) => uml.source.lines[lines.indexOf(head)];
  assert.deepEqual([declared('class Seat_Holds {').id, declared('class Seat_Holds_2 {').id], ['SeatHolds', 'SeatHoldRows']);
});

// ---- Source map: relation, message, and fragment lines ----------------------------------------

const CLASS_ARROWS = { extends: '--|>', implements: '..|>', collaborator: '..>' };

/** Whether a class relation entry is declared in the model: a relationship, or an extends or implements entry. */
function declaresRelation(model, entry) {
  if (entry.relation === 'collaborator') {
    return model.relationships.some((relationship) => relationship.id === entry.relationshipId
      && relationship.sourceId === entry.modelFrom && relationship.targetId === entry.modelTo);
  }
  return entry.relationshipId === null && model.elements.get(entry.modelFrom).code[entry.relation].includes(entry.modelTo);
}

/** Whether a deployment link entry is in the model: a node's link, or relationships lifted to the two instances. */
function linkInModel({ design, viewModel }, entry) {
  const { model } = design;
  if (!entry.derived) {
    return entry.relationshipIds.length === 0
      && model.environments.get(viewModel.scopeId).nodes.get(entry.from).relationships.some((link) => link.targetId === entry.to);
  }
  const [fromElement, toElement] = [entry.from, entry.to].map((key) => key.split('@')[0]);
  return entry.relationshipIds.length > 0 && entry.relationshipIds.every((id) => model.relationships.some((relationship) =>
    relationship.id === id && isSameOrInside(model, relationship.sourceId, fromElement) && isSameOrInside(model, relationship.targetId, toElement)));
}

/** The lines whose entry has one of `kinds`, by index. */
const linesOfKind = (source, ...kinds) => source.lines.flatMap((entry, index) => (entry && kinds.includes(entry.kind) ? [index] : []));

/** The component that declares each port alias. */
const portOwners = (parsed) => new Map(parsed.components.flatMap((component) => component.ports.map((port) => [port.alias, component.name])));

const RELATION_LINES = {
  class({ selector, design, uml }) {
    const relations = parse(uml).relationships;
    const lines = uml.text.split('\n');
    assert.deepEqual(linesOfKind(uml.source, 'relation'), relations.map((relation) => relation.sourceIndex), `${selector}: relation lines`);
    relations.forEach((relation) => {
      const entry = uml.source.lines[relation.sourceIndex];
      const at = `${selector} line ${relation.sourceIndex}`;
      assert.deepEqual([entry.from, entry.to], [uml.ids[relation.from], uml.ids[relation.to]], `${at}: the drawn ends`);
      assert.ok(lines[relation.sourceIndex].includes(` ${CLASS_ARROWS[entry.relation]} `), `${at}: ${entry.relation} is drawn with its arrow`);
      assert.ok(declaresRelation(design.model, entry), `${at}: ${entry.relation} from ${entry.modelFrom} to ${entry.modelTo} is declared`);
      assert.ok(isSameOrInside(design.model, entry.modelFrom, entry.from) && isSameOrInside(design.model, entry.modelTo, entry.to),
        `${at}: each drawn box stands for its declared end`);
    });
  },
  sequence({ selector, design, viewModel, uml }) {
    const scenario = design.model.scenarios.get(viewModel.scopeId);
    const statuses = core.classifySteps(design, viewModel.scopeId);
    const items = parse(uml).messages.filter((item) => /^(message|fragment_)/.test(item.type));
    assert.deepEqual(linesOfKind(uml.source, 'message', 'fragment', 'branch', 'fragment-end'), items.map((item) => item.sourceIndex),
      `${selector}: message and fragment lines`);
    const open = [];
    items.forEach((item) => {
      const entry = uml.source.lines[item.sourceIndex];
      const at = `${selector} line ${item.sourceIndex}`;
      if (item.type === 'message') {
        const step = itemAt(scenario.steps, entry);
        assert.deepEqual([entry.kind, step.from, step.to], ['message', uml.ids[item.from], uml.ids[item.to]], `${at}: the step's ends`);
        assert.equal(entry.status, itemAt(statuses, entry).status, `${at}: the step's status`);
      } else if (item.type === 'fragment_start') {
        assert.deepEqual([entry.kind, entry.operator, itemAt(scenario.steps, entry).operator], ['fragment', item.fragType, item.fragType], at);
        open.push({ entry, branch: 0 });
      } else {
        const fragment = item.type === 'fragment_else' ? open[open.length - 1] : open.pop();
        const own = { containerPath: fragment.entry.containerPath, index: fragment.entry.index };
        if (item.type === 'fragment_else') fragment.branch += 1;
        const expected = item.type === 'fragment_else' ? Object.assign({ kind: 'branch', branch: fragment.branch }, own) : Object.assign({ kind: 'fragment-end' }, own);
        assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, entry[key]])), expected, `${at}: the fragment it belongs to`);
      }
    });
  },
  deployment(view) {
    const { selector, uml } = view;
    const links = parse(uml).links;
    assert.deepEqual(linesOfKind(uml.source, 'link'), links.map((link) => link.sourceIndex), `${selector}: link lines`);
    links.forEach((link) => {
      const entry = uml.source.lines[link.sourceIndex];
      assert.deepEqual([entry.from, entry.to], [uml.ids[link.from], uml.ids[link.to]], `${selector} line ${link.sourceIndex}: the drawn ends`);
      assert.ok(linkInModel(view, entry), `${selector} line ${link.sourceIndex}: the link is in the model`);
    });
  },
  component({ selector, viewModel, uml }) {
    const owners = portOwners(parse(uml));
    const connectorLines = uml.text.split('\n').flatMap((line, index) => {
      const match = /^(\S+) --> (\S+)/.exec(line);
      return match ? [{ index, ball: match[1], socket: match[2] }] : [];
    });
    assert.deepEqual(linesOfKind(uml.source, 'assembly'), connectorLines.map((line) => line.index), `${selector}: assembly lines`);
    connectorLines.forEach(({ index, ball, socket }) => {
      const entry = uml.source.lines[index];
      const expected = { interfaceId: uml.ids[ball], providerId: uml.ids[owners.get(ball)], consumerId: uml.ids[owners.get(socket)] };
      assert.equal(uml.ids[socket], expected.interfaceId, `${selector} line ${index}: ball and socket name one interface`);
      assert.deepEqual({ interfaceId: entry.interfaceId, providerId: entry.providerId, consumerId: entry.consumerId }, expected, `${selector} line ${index}`);
      assert.ok(viewModel.uml.assemblies.some((assembly) => ['interfaceId', 'providerId', 'consumerId'].every((key) => assembly[key] === expected[key])),
        `${selector} line ${index}: the view draws that assembly`);
    });
  },
};

test('every relation, message, and fragment line has a source entry naming its model thing', () => {
  VIEWS.forEach(([design, selector]) => {
    const view = drawn(design, selector);
    assert.equal(view.uml.source.lines.length, view.uml.text.split('\n').length, `${selector}: one entry per line`);
    RELATION_LINES[view.uml.type](view);
  });
});

// ---- Source map: declaration lines -------------------------------------------------------------

/** The class and member entries of a class diagram's lines, compared with the model's code elements. */
function checkClassDeclarations({ selector, design, viewModel, uml }) {
  const lines = uml.text.split('\n');
  let open = null;
  lines.forEach((line, index) => {
    const entry = uml.source.lines[index];
    const at = `${selector} line ${index}`;
    const head = /^(?:class|interface|enum|abstract class) (\S+)/.exec(line);
    if (head) {
      const drawnClass = viewModel.uml.classes.find((candidate) => candidate.id === uml.ids[head[1]]);
      assert.deepEqual(entry, { kind: 'element', id: drawnClass.id, lifted: drawnClass.lifted }, at);
      if (line.endsWith('{')) open = { id: drawnClass.id, members: membersOf(design.model.elements.get(drawnClass.id)) };
    } else if (open && line === '}') {
      assert.deepEqual([entry, open.members.length], [null, 0], `${at}: the class closes after its last member`);
      open = null;
    } else if (open) {
      const { text, ...member } = open.members.shift();
      assert.equal(line, `  ${text}`, `${at}: the member's text`);
      assert.deepEqual(entry, Object.assign({ kind: 'member', id: open.id }, member), at);
    }
  });
}

/** A code element's members as drawn: attributes, then operations, or its own call for a function that declares none. */
function membersOf(element) {
  const { attributes, operations } = element.code;
  const synthesized = element.kind === 'function' && operations.length === 0;
  return attributes.map((text, index) => ({ list: 'attributes', index, synthesized: false, text }))
    .concat((synthesized ? [`${element.name}()`] : operations).map((text, index) => ({ list: 'operations', index, synthesized, text })));
}

function checkSequenceDeclarations({ selector, design, uml }) {
  let box = null;
  uml.text.split('\n').forEach((line, index) => {
    const entry = uml.source.lines[index];
    const boxHead = /^box "([^"]*)"/.exec(line);
    const participant = /^(?:participant|actor) (\S+): /.exec(line);
    if (boxHead) {
      box = entry.id;
      assert.deepEqual([entry.kind, design.model.elements.get(entry.id).name], ['box', boxHead[1]], `${selector} line ${index}`);
    } else if (line === 'end box') {
      box = null;
    } else if (participant) {
      assert.deepEqual(entry, { kind: 'participant', id: uml.ids[participant[1]], boxId: box }, `${selector} line ${index}`);
    }
  });
}

function checkDeploymentDeclarations({ selector, uml }) {
  const parsed = parse(uml);
  parsed.elements.forEach((element) => {
    const entry = uml.source.lines[element.sourceLine];
    const parentId = element.parentId === null ? null : uml.ids[element.parentId];
    const expected = element.kind === 'node'
      ? { kind: 'node', id: uml.ids[element.name], parentId }
      : { kind: 'instance', elementId: uml.ids[element.name].split('@')[0], nodeId: parentId };
    assert.deepEqual(entry, expected, `${selector} line ${element.sourceLine}`);
    if (element.kind !== 'node') assert.equal(uml.ids[element.name], `${expected.elementId}@${parentId}`);
  });
}

function checkComponentDeclarations({ selector, viewModel, uml }) {
  const parsed = parse(uml);
  const owners = portOwners(parsed);
  uml.text.split('\n').forEach((line, index) => {
    const entry = uml.source.lines[index];
    const component = /^component "[^"]*" as (\S+)/.exec(line);
    const port = /^ {2}(provide|require) "[^"]*" as (\S+)$/.exec(line);
    if (component) {
      const box = viewModel.uml.components.find((candidate) => candidate.id === uml.ids[component[1]]);
      assert.deepEqual(entry, { kind: 'element', id: box.id, role: box.role }, `${selector} line ${index}`);
    } else if (port) {
      const elementId = uml.ids[owners.get(port[2])];
      const connector = parsed.connectors.find((candidate) => candidate.fromPort === port[2]);
      const consumerId = port[1] === 'require' ? elementId : connector ? uml.ids[connector.to] : null;
      assert.deepEqual(entry, { kind: 'port', role: port[1] === 'provide' ? 'provided' : 'required', interfaceId: uml.ids[port[2]], elementId, consumerId },
        `${selector} line ${index}`);
    }
  });
}

const DECLARATION_LINES = { class: checkClassDeclarations, sequence: checkSequenceDeclarations, deployment: checkDeploymentDeclarations,
  component: checkComponentDeclarations };

test('declaration lines name the element, member, participant, box, node, instance, or port they declare', () => {
  VIEWS.forEach(([design, selector]) => {
    const view = drawn(design, selector);
    DECLARATION_LINES[view.uml.type](view);
  });
});

test('a function that declares no operation has its own call as a synthesized member', () => {
  const withAudit = load(replaced(EDITING, '            code:\n              SeatLedger:',
    '            code:\n              audit:\n                kind: function\n              SeatLedger:'));
  const { uml } = drawn(withAudit, 'code of seats');
  const lines = uml.text.split('\n');
  assert.deepEqual(uml.source.lines[lines.indexOf('  audit()')], { kind: 'member', id: 'audit', list: 'operations', index: 0, synthesized: true });
});

// ---- Anchors -----------------------------------------------------------------------------------

/** Each anchor line of a dynamic view, found by its text (`after` picks the line that follows a text), with its position. */
function anchorsOf(design, scenarioId, anchors) {
  const { uml } = drawn(design, `dynamic ${scenarioId}`);
  const lines = uml.text.split('\n');
  return anchors.map(([where, expected]) => {
    const index = typeof where === 'string' ? lines.indexOf(where) : lines.indexOf(where.after) + 1;
    assert.ok(index > 0, `${JSON.stringify(where)} is a line of dynamic ${scenarioId}`);
    return [`before line ${index} "${lines[index]}"`, core.positionForAnchor(uml.source, index), expected];
  });
}

const SECTIONS_OPEN = [3, 'alt', 0];
const EACH_SECTION = [3, 'alt', 0, 'steps', 0, 'loop'];

test('anchors map to step positions at the first and last step, in an empty branch, between else and end, and two fragments deep', () => {
  // probe: 0 web -> coordinator, 1 a step to the unknown registrar (not drawn), 2 coordinator -> policy, 3 alt [loop [one step]]
  // [else, empty], 4 to 6 one step each.
  const withAnchors = load(replaced(EDITING, '      - web -> policy: asks for a decision from\n', [
    '      - web -> policy: asks for a decision from',
    '  anchors:',
    '    title: Anchors at the edges of branches',
    '    steps:',
    '      - alt:',
    '          - when: nothing is checked yet',
    '          - when: only a registrar is asked',
    '            steps:',
    '              - web -> registrar: asks a registrar about',
    '',
  ].join('\n')));
  const checks = anchorsOf(editing, 'probe', [
    ['web -> coordinator: submits the plan to [JSON/HTTPS]', { containerPath: [], index: 0 }],
    ['coordinator -> policy: asks for an eligibility decision from', { containerPath: [], index: 2 }],
    ['alt [sections are open]', { containerPath: [], index: 3 }],
    ['loop [each section]', { containerPath: SECTIONS_OPEN, index: 0 }],
    ['coordinator -> seats: reserves a seat through', { containerPath: EACH_SECTION, index: 0 }],
    [{ after: 'coordinator -> seats: reserves a seat through' }, { containerPath: EACH_SECTION, index: 1 }],
    ['else [no section is open]', { containerPath: SECTIONS_OPEN, index: 1 }],
    [{ after: 'else [no section is open]' }, { containerPath: [3, 'alt', 1], index: 0 }],
    ['web -> policy: asks for a decision from', { containerPath: [], index: 6 }],
    ['@enduml', { containerPath: [], index: 7 }],
  ]).concat(anchorsOf(withAnchors, 'anchors', [
    ['else [only a registrar is asked]', { containerPath: [0, 'alt', 0], index: 0 }],
    [{ after: 'else [only a registrar is asked]' }, { containerPath: [0, 'alt', 1], index: 1 }],
    ['@enduml', { containerPath: [], index: 1 }],
  ]));
  assert.deepEqual(checks.map(([where, position]) => [where, position]), checks.map(([where, , expected]) => [where, expected]));
});

test('a line before which no step can go is no anchor', () => {
  const { uml } = drawn(editing, 'dynamic probe');
  const lines = uml.text.split('\n');
  ['@startuml', 'layout wrap 120', 'box "Registration API"', 'participant policy: Enrollment Policy', 'end box']
    .forEach((line) => assert.equal(core.positionForAnchor(uml.source, lines.indexOf(line)), null, line));
});

test('a position for an anchor is a copy the caller may change', () => {
  const { uml } = drawn(editing, 'dynamic probe');
  const line = uml.text.split('\n').indexOf('coordinator -> seats: reserves a seat through');
  core.positionForAnchor(uml.source, line).containerPath.push('changed');
  assert.deepEqual(core.positionForAnchor(uml.source, line), { containerPath: EACH_SECTION, index: 0 });
});

// ---- Aliases -----------------------------------------------------------------------------------

/** The alias of each model thing, from `ids`. */
const aliasesByThing = (ids) => Object.fromEntries(Object.entries(ids).map(([alias, value]) => [value, alias]));

/** The aliases of a view's other things, without the things in `changed` (keys before and after the change). */
function otherAliases(design, selector, changed) {
  const aliases = aliasesByThing(drawn(design, selector).uml.ids);
  changed.forEach((key) => delete aliases[key]);
  return aliases;
}

test('renaming an unrelated element changes no other alias', () => {
  const renamedId = core.edit(editing, { op: 'changeElementId', elementId: 'billing-gateway', newId: 'billing-adapter' });
  assert.equal(renamedId.error, undefined);
  const cases = [
    ['code of policy', load(replaced(EDITING, '              UnitCapRule:\n', '              UnitCapRule:\n                name: Unit Limit Rule\n')), ['UnitCapRule']],
    ['dynamic enroll', load(renamedId.text), ['billing-gateway', 'billing-adapter']],
    ['deployment production', load(replaced(EDITING, 'canary: {name: Canary pod', 'canary-west: {name: Canary pod')),
      ['canary', 'api@canary', 'canary-west', 'api@canary-west']],
  ];
  cases.forEach(([selector, renamed, changed]) =>
    assert.deepEqual(otherAliases(renamed, selector, changed), otherAliases(editing, selector, changed), selector));
  const renamedComponent = load(replaced(INTERFACES, 'name: Planner Web App', 'name: Planner App'));
  assert.deepEqual(drawn(renamedComponent, 'interfaces of api').uml.ids, drawn(interfaces, 'interfaces of api').uml.ids, 'interfaces of api');
  assert.equal(aliasesByThing(drawn(cases[0][1], 'code of policy').uml.ids).UnitCapRule, 'Unit_Limit_Rule', 'the renamed class has a new alias');
});

// The words the UML editor's own guard lists for sequence diagrams (SEQUENCE_KEYWORDS in _includes/uml-editor.html, M3).
const EDITOR_SEQUENCE_KEYWORDS = ['participant', 'actor', 'activate', 'deactivate', 'create', 'destroy', 'note',
  'alt', 'opt', 'loop', 'par', 'break', 'critical', 'ref', 'neg', 'else', 'end'];

test('the sequence keywords include every word the UML editor guards against', () => {
  assert.deepEqual(Object.keys(UML_ALIAS_KEYWORDS).sort(), ['class', 'deployment', 'sequence']);
  assert.deepEqual(EDITOR_SEQUENCE_KEYWORDS.filter((word) => !UML_ALIAS_KEYWORDS.sequence.includes(word)), []);
});

/** The n-th listed word in the n-th letter case: loop, Alt, END, … */
const LETTER_CASES = [(word) => word, (word) => word[0].toUpperCase() + word.slice(1), (word) => word.toUpperCase()];
const inCase = (word, n) => LETTER_CASES[n % LETTER_CASES.length](word);

/**
 * One model per keyword and type, with the keyword where the text puts an alias at the start of a line: an element id
 * that sends a message (sequence), a code element's name (class), and an element id and a node id with links (deployment).
 * `expected` maps the alias the text must use to the thing it stands for.
 */
const KEYWORD_MODELS = {
  sequence(word, n) {
    const id = inCase(word, n);
    return { selector: 'dynamic run', expected: { [`${id}_`]: id }, text: [
      'schema: c4-design/1', 'name: Keyword probe',
      'people:', '  student:', '    name: Student', '    collaborators:', `      ${id}: uses`,
      'systems:', `  ${id}:`, '    name: Keyword system', '    collaborators:', '      other: asks', '  other:', '    name: Other system',
      'scenarios:', '  run:', '    title: Run', '    steps:', `      - student -> ${id}: uses`, `      - ${id} -> other: asks`,
    ].join('\n') };
  },
  class(word, n) {
    const name = inCase(word, n);
    return { selector: 'code of core', expected: { [`${name}_`]: 'Probe' }, text: [
      'schema: c4-design/1', 'name: Keyword probe',
      'systems:', '  app:', '    name: App', '    containers:', '      api:', '        name: API', '        components:',
      '          core:', '            name: Core', '            code:',
      '              Probe:', `                name: ${name}`, '                kind: class', '                extends: [Base]',
      '                collaborators:', '                  Helper: asks',
      '              Base: {kind: class}', '              Helper: {kind: class}',
    ].join('\n') };
  },
  deployment(word, n) {
    const [elementId, nodeId] = [inCase(word, n), inCase(word, n + 1)];
    return { selector: 'deployment live', expected: { [`${elementId}_`]: `${elementId}@${nodeId}`, [`${nodeId}_`]: nodeId }, text: [
      'schema: c4-design/1', 'name: Keyword probe',
      'systems:', `  ${elementId}:`, '    name: Keyword system', '    collaborators:', '      other: sends data to',
      '  other:', '    name: Other system',
      'deployment:', '  live:', '    name: Live', '    nodes:',
      `      ${nodeId}: {name: Keyword node, hosts: [${elementId}], collaborators: {relay: forwards requests to}}`,
      '      host-b: {name: Other node, hosts: [other]}', '      relay: {name: Relay node}',
    ].join('\n') };
  },
};

test('no alias equals a listed keyword in any letter case', () => {
  Object.entries(UML_ALIAS_KEYWORDS).forEach(([type, words]) => {
    const listed = new Set(words);
    assert.ok(words.length > 0 && words.every((word) => word === word.toLowerCase()), `${type}: lower-case words`);
    words.forEach((word, n) => {
      const { selector, expected, text } = KEYWORD_MODELS[type](word, n);
      const { uml } = drawn(load(text), selector);
      assert.equal(uml.type, type);
      assert.deepEqual(Object.keys(uml.ids).filter((alias) => listed.has(alias.toLowerCase())), [], `${type} model for ${word}: no keyword alias`);
      Object.entries(expected).forEach(([alias, thing]) => assert.equal(uml.ids[alias], thing, `${type} model for ${word}: ${alias}`));
    });
  });
});

test('a keyword alias takes its underscore before the collision suffix', () => {
  const twoEnums = load(replaced(replaced(EDITING, '              SeatHolds:\n                name: Seat Holds', '              SeatHolds:\n                name: enum'),
    '              SeatHoldRows:\n                name: Seat_Holds', '              SeatHoldRows:\n                name: enum'));
  const { ids } = drawn(twoEnums, 'code of policy').uml;
  assert.deepEqual([ids.enum_, ids.enum__2], ['SeatHolds', 'SeatHoldRows']);
});
