'use strict';

// The rules the inspector's forms and the UML-view canvases share, each owned by the core (UML-view editing spec §4.3):
// containment (`isNested`), the ends a scenario step may have at a position (`stepEnds`, `structuralSenders`), and
// which code element may extend or implement which (`inheritanceProblem`, enforced by `setList`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadCore, fixture } = require('./helpers.js');

const ARCHUML_ROOT = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ARCHUML_ROOT, 'c4', 'manifest.json'), 'utf8'));
const REFERENCE = fixture('course-registration.yml');

const core = loadCore();
const reference = () => core.load(REFERENCE, { source: 'file' });

/** The ends of a step inserted at `index` of a step list of the reference model's `enroll` scenario. */
function endsInEnroll(index, containerPath = []) {
  return core.stepEnds(reference(), { scenarioId: 'enroll', containerPath, index, replace: false });
}

// ---- Step ends -----------------------------------------------------------------------------------

test('each reason code has one partition', async (t) => {
  // `enroll`: web -> coordinator, coordinator -> policy, then an alt; index 3 is the end of the scenario.
  const partitions = [
    ['no-relationship', 'seats', 'web', 3],
    ['reply-without-request', 'policy', 'coordinator', 0],
    ['asynchronous-no-reply', 'billing', 'billing-gateway', 3],
    ['unknown-element', 'ghost', 'web', 3],
    ['nested-ends', 'api', 'coordinator', 3],
    ['same-element', 'policy', 'policy', 3],
  ];
  for (const [code, from, to, index] of partitions) {
    await t.test(`${code}: a step from ${from} to ${to} at step ${index} of enroll`, () => {
      assert.equal(endsInEnroll(index).problemOf(from, to), code);
    });
  }
});

test('a reply is accepted only where the request it answers is open', () => {
  // coordinator -> policy is step 2 of enroll, so policy may answer it from index 2 on, and not before it.
  assert.equal(endsInEnroll(0).problemOf('policy', 'coordinator'), 'reply-without-request');
  assert.equal(endsInEnroll(2).problemOf('policy', 'coordinator'), null);
  assert.ok(endsInEnroll(2).tosOf('policy').includes('coordinator'));
  // Each branch of the alt starts from the requests open before it: only the first branch asks billing-gateway.
  assert.equal(endsInEnroll(2, [2, 'alt', 0]).problemOf('billing-gateway', 'coordinator'), null);
  assert.equal(endsInEnroll(1, [2, 'alt', 1]).problemOf('billing-gateway', 'coordinator'), 'reply-without-request');
});

test('problemOf is null exactly for the ends that froms and tosOf offer', () => {
  const design = reference();
  const ids = [...design.model.elements.keys()];
  // Each step list of enroll with its length: the scenario's own, and the two branches of its alt.
  [[[], 3], [[2, 'alt', 0], 2], [[2, 'alt', 1], 1]].forEach(([containerPath, length]) => {
    for (let index = 0; index <= length; index += 1) {
      const ends = core.stepEnds(design, { scenarioId: 'enroll', containerPath, index, replace: false });
      const offered = ids.flatMap((from) => ends.tosOf(from).map((to) => `${from} to ${to}`));
      const accepted = ids.flatMap((from) => ids.filter((to) => ends.problemOf(from, to) === null).map((to) => `${from} to ${to}`));
      assert.deepEqual(accepted, offered, `at ${JSON.stringify(containerPath)} index ${index}`);
      assert.deepEqual(ends.froms, ids.filter((from) => ends.tosOf(from).length > 0), `froms at ${JSON.stringify(containerPath)} index ${index}`);
    }
  });
});

test('with a sender, only that sender is offered, with the receivers it has without one', () => {
  const design = reference();
  const options = { scenarioId: 'enroll', containerPath: [], index: 3, replace: false };
  const all = core.stepEnds(design, options);
  const coordinator = core.stepEnds(design, Object.assign({}, options, { sender: 'coordinator' }));
  assert.deepEqual(coordinator.froms, ['coordinator']);
  assert.deepEqual(coordinator.tosOf('coordinator'), all.tosOf('coordinator'));
  assert.deepEqual(coordinator.tosOf('web'), []);
});

test('one stepEnds call classifies the scenario twice, in a large model as in a small one', () => {
  // The cost of the step pickers and of a message gesture (spec §7.9, §9.2) is counted where the core classifies.
  const projection = require('../../c4/c4-projection.js');
  // A system of 40 containers in a chain of relationships, before the reference model's systems.
  const archive = Array.from({ length: 40 }, (unused, index) => [`      part-${index + 1}:`, `        name: Archive part ${index + 1}`]
    .concat(index < 39 ? [`        collaborators: {part-${index + 2}: copies old records to}`] : []).join('\n'));
  const large = REFERENCE.replace(/^systems:\n/m, ['systems:', '  archive:', '    name: Archive', '    containers:']
    .concat(archive, ['']).join('\n'));
  const classificationsOf = (text) => {
    const design = core.load(text, { source: 'file' });
    const classifySteps = projection.classifySteps;
    let count = 0;
    projection.classifySteps = (...args) => { count += 1; return classifySteps(...args); };
    try {
      core.stepEnds(design, { scenarioId: 'enroll', containerPath: [], index: 2, replace: false });
    } finally {
      projection.classifySteps = classifySteps;
    }
    return { elements: design.model.elements.size, count };
  };
  const [small, big] = [classificationsOf(REFERENCE), classificationsOf(large)];
  assert.equal(big.elements, small.elements + 41, 'the large model really has 41 more elements');
  assert.deepEqual([small.count, big.count], [2, 2]);
});

test('a scenario the design does not have offers no ends', () => {
  const ends = core.stepEnds(reference(), { scenarioId: 'nothing', containerPath: [], index: 0, replace: false });
  assert.deepEqual(ends.froms, []);
  assert.deepEqual(ends.tosOf('web'), []);
  assert.equal(ends.problemOf('web', 'coordinator'), 'unknown-element');
});

test('structuralSenders lists every element that sends or answers along a relationship', () => {
  // Every end of a relationship, and every element that contains one without containing the other end, in model
  // order; PrerequisiteRule and UnitCapRule implement an interface and collaborate with no one.
  assert.deepEqual(core.structuralSenders(reference()), [
    'student', 'registration', 'web', 'api', 'coordinator', 'policy', 'EnrollmentPolicy', 'EnrollmentRule', 'seats',
    'billing-gateway', 'db', 'billing',
  ]);
});

test('an unreadable design has no step ends and no senders', () => {
  const design = core.load('systems:\n  a:\n    name: [unclosed\n', { source: 'embed' });
  assert.deepEqual(core.stepEnds(design, { scenarioId: 'enroll', containerPath: [], index: 0, replace: false }).froms, []);
  assert.deepEqual(core.structuralSenders(design), []);
});

// ---- Containment ---------------------------------------------------------------------------------

test('isNested is true for an element and its part in both orders and false for siblings', () => {
  const { model } = reference();
  assert.equal(core.isNested(model, 'api', 'coordinator'), true);
  assert.equal(core.isNested(model, 'coordinator', 'api'), true);
  assert.equal(core.isNested(model, 'registration', 'EnrollmentPolicy'), true, 'a part of a part');
  assert.equal(core.isNested(model, 'coordinator', 'policy'), false, 'siblings');
  assert.equal(core.isNested(model, 'web', 'coordinator'), false, 'parts of siblings');
  assert.equal(core.isNested(model, 'api', 'api'), false, 'an element is not inside itself');
});

// ---- Inheritance ---------------------------------------------------------------------------------

const CODE_KINDS = ['class', 'abstract_class', 'interface', 'enum', 'function', 'module'];

/** A component with one source and one target code element of each kind (`Sclass`, `Tclass`, …). */
function allKinds() {
  const lines = ['systems:', '  s:', '    name: S', '    containers:', '      c:', '        name: C', '        components:',
    '          k:', '            name: K', '            code:'];
  CODE_KINDS.forEach((kind) => lines.push(`              S${kind}: {kind: ${kind}}`, `              T${kind}: {kind: ${kind}}`));
  return core.load(`${lines.join('\n')}\n`, { source: 'file' });
}

test('inheritanceProblem over every pair of code kinds and both relations matches the kind rule', () => {
  // Spec §4.3: a class or an abstract class extends a class or an abstract class; an interface extends an interface;
  // a class, an abstract class, or an enum implements an interface; a function and a module extend and implement nothing.
  const allowed = [
    'class extends class', 'class extends abstract_class', 'abstract_class extends class',
    'abstract_class extends abstract_class', 'interface extends interface',
    'class implements interface', 'abstract_class implements interface', 'enum implements interface',
  ];
  const refusedAs = (source, relation, target) => {
    if (allowed.includes(`${source} ${relation} ${target}`)) return null;
    return relation === 'implements' && target !== 'interface' ? 'implements-target' : 'extends-kind';
  };
  const design = allKinds();
  const expected = {};
  const actual = {};
  CODE_KINDS.forEach((source) => ['extends', 'implements'].forEach((relation) => CODE_KINDS.forEach((target) => {
    const pair = `${source} ${relation} ${target}`;
    expected[pair] = refusedAs(source, relation, target);
    actual[pair] = core.inheritanceProblem(design, `S${source}`, relation, `T${target}`);
  })));
  assert.equal(Object.keys(actual).length, 72);
  assert.deepEqual(actual, expected);
});

test('a cycle is extends-cycle', () => {
  const text = REFERENCE
    .replace('              PrerequisiteRule:\n                kind: class\n',
      '              PrerequisiteRule:\n                kind: class\n                extends: [UnitCapRule]\n')
    .replace('              UnitCapRule:\n                kind: class\n',
      '              UnitCapRule:\n                kind: class\n                extends: [EnrollmentPolicy]\n');
  const design = core.load(text, { source: 'file' });
  assert.equal(core.inheritanceProblem(design, 'EnrollmentPolicy', 'extends', 'PrerequisiteRule'), 'extends-cycle', 'two steps back');
  assert.equal(core.inheritanceProblem(design, 'EnrollmentPolicy', 'extends', 'UnitCapRule'), 'extends-cycle', 'one step back');
  assert.equal(core.inheritanceProblem(design, 'EnrollmentPolicy', 'extends', 'EnrollmentPolicy'), 'extends-cycle', 'itself');
  assert.equal(core.inheritanceProblem(design, 'PrerequisiteRule', 'extends', 'EnrollmentPolicy'), null, 'along the chain');
});

test('a component target is extends-target', () => {
  const design = reference();
  assert.equal(core.inheritanceProblem(design, 'PrerequisiteRule', 'extends', 'seats'), 'extends-target');
  assert.equal(core.inheritanceProblem(design, 'PrerequisiteRule', 'implements', 'seats'), 'extends-target');
  assert.equal(core.inheritanceProblem(design, 'PrerequisiteRule', 'implements', 'ghost'), 'extends-target', 'no element at all');
});

test('setList refuses an added extends entry with its code and leaves an existing one alone', () => {
  const added = core.edit(reference(), { op: 'setList', elementId: 'PrerequisiteRule', field: 'extends', items: ['EnrollmentRule'] });
  assert.equal(added.error, 'extends-kind');
  assert.equal(added.text, undefined);

  // A hand-written entry the kind rule forbids stays, and another entry can still be added beside it.
  const handWritten = core.load(REFERENCE.replace(
    '              PrerequisiteRule:\n                kind: class\n',
    '              PrerequisiteRule:\n                kind: class\n                extends: [EnrollmentRule]\n'), { source: 'file' });
  const kept = core.edit(handWritten, { op: 'setList', elementId: 'PrerequisiteRule', field: 'extends', items: ['EnrollmentRule', 'UnitCapRule'] });
  assert.equal(kept.error, undefined);
  assert.deepEqual(core.load(kept.text).model.elements.get('PrerequisiteRule').code.extends, ['EnrollmentRule', 'UnitCapRule']);
});

test('setList refuses an added implements entry with its code', () => {
  const added = core.edit(reference(), { op: 'setList', elementId: 'EnrollmentPolicy', field: 'implements', items: ['UnitCapRule'] });
  assert.equal(added.error, 'implements-target');
  const allowed = core.edit(reference(), { op: 'setList', elementId: 'EnrollmentPolicy', field: 'implements', items: ['EnrollmentRule'] });
  assert.deepEqual(core.load(allowed.text).model.elements.get('EnrollmentPolicy').code.implements, ['EnrollmentRule']);
});

// ---- One core for every host ---------------------------------------------------------------------

test("a page that loads the manifest's core scripts gets the same answers as Node", () => {
  const context = vm.createContext({});
  context.self = context;
  manifest.core.forEach((file) => vm.runInContext(fs.readFileSync(path.join(ARCHUML_ROOT, file), 'utf8'), context, { filename: file }));
  context.text = REFERENCE;
  const classic = vm.runInContext(`(function () {
    var design = ArchUMLC4.load(text, { source: 'file' });
    var ends = ArchUMLC4.stepEnds(design, { scenarioId: 'enroll', containerPath: [], index: 2, replace: false });
    return JSON.stringify({
      froms: ends.froms, tos: ends.tosOf('policy'), problem: ends.problemOf('seats', 'web'),
      senders: ArchUMLC4.structuralSenders(design),
      nested: ArchUMLC4.isNested(design.model, 'coordinator', 'api'),
      inheritance: ArchUMLC4.inheritanceProblem(design, 'PrerequisiteRule', 'extends', 'EnrollmentRule'),
    });
  })()`, context);
  const design = reference();
  const ends = core.stepEnds(design, { scenarioId: 'enroll', containerPath: [], index: 2, replace: false });
  assert.deepEqual(JSON.parse(classic), {
    froms: ends.froms, tos: ends.tosOf('policy'), problem: 'no-relationship',
    senders: core.structuralSenders(design), nested: true, inheritance: 'extends-kind',
  });
});
