'use strict';

// The commands the UML-view canvases and the inspector forms share (UML-view editing spec §4.3, §14 D1): steps moved
// across step lists, wrapped in and unwrapped from fragments, fragment operators, guards, and branches; deployment
// nodes moved, linked, unlinked, and given a new id; and the stored view selectors that name an interface's card.
// Each command is held to C4 spec §4.9: its edits are splices that turn the input into its output, so the bytes
// outside them stay as they were, and a command followed by its inverse gives the text back.
const test = require('node:test');
const assert = require('node:assert/strict');
const yamlAdapter = require('../../c4/c4-yaml.js');
const { loadCore, fixture } = require('./helpers.js');

const core = loadCore();
const REFERENCE = fixture('course-registration.yml');
const INTERFACES = fixture('course-registration-interfaces.yml');

const load = (text) => core.load(text, { source: 'file' });

/** `text` with `from` replaced by `to`; fails when `from` is absent, so an expected text cannot silently miss. */
function replaced(text, from, to) {
  assert.ok(text.includes(from), `the model text contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

/** `text` with a `layout:` section appended whose lines are `entryLines`, each indented below `layout:`. */
function withLayout(text, ...entryLines) {
  return `${text.replace(/\n*$/, '\n')}layout:\n${entryLines.map((line) => `  ${line}\n`).join('')}`;
}

/** Applies `command` to `text`; fails unless it succeeds, its edits turn the input into its text, and that text parses. */
function applied(text, command) {
  const result = core.edit(load(text), command);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(yamlAdapter.applyEdits(text, result.edits), result.text, 'the edits turn the input into the returned text');
  assert.deepEqual(yamlAdapter.parse(result.text).errors, [], 'the returned text is YAML without errors');
  return result;
}

/** The refusal code `command` gets on `text`. */
function refusalOf(text, command) {
  return core.edit(load(text), command).error;
}

/** The data at `path` of the YAML `text`, every scalar as text. */
function dataAt(text, path) {
  return path.reduce((value, segment) => (value == null ? undefined : value[segment]), yamlAdapter.toData(yamlAdapter.parse(text)));
}

/** A scenario's steps as the model reads them: `from->to` for a message, `operator[guard|guard]` for a fragment. */
function stepSummary(text, scenarioId) {
  const summary = (step) => (step.kind === 'fragment'
    ? `${step.operator}[${step.branches.map((branch) => `${branch.when}: ${branch.steps.map(summary).join(', ')}`).join(' | ')}]`
    : `${step.from}->${step.to}`);
  return load(text).model.scenarios.get(scenarioId).steps.map(summary);
}

/** A deployment node of `production` as the model reads it. */
function nodeOf(text, nodeId) {
  return load(text).model.environments.get('production').nodes.get(nodeId);
}

// ---- The enroll scenario of the reference model, line by line ---------------------------------------------------

const FIRST = '      - web -> coordinator: submits the plan to\n';
const SECOND = '      - coordinator -> policy: asks for an eligibility decision from\n';
const ELIGIBLE = [
  '          - when: eligible\n',
  '            steps:\n',
  '              - coordinator -> seats: reserves all seats or none through\n',
  '              - coordinator -> billing-gateway: asks for tuition charges through\n',
].join('');
const REPLY = '              - coordinator -> web: reports the refusal and its reason to\n';
const NOT_ELIGIBLE = `          - when: not eligible\n            steps:\n${REPLY}`;
const ALT = `      - alt:\n${ELIGIBLE}${NOT_ELIGIBLE}`;
// The alt with its second branch left out, and the opt the one branch makes.
const ONE_BRANCH = replaced(REFERENCE, NOT_ELIGIBLE, '');
const OPT = [
  '      - opt:\n',
  '          when: eligible\n',
  '          steps:\n',
  '            - coordinator -> seats: reserves all seats or none through\n',
  '            - coordinator -> billing-gateway: asks for tuition charges through\n',
].join('');
const WITH_OPT = replaced(ONE_BRANCH, `      - alt:\n${ELIGIBLE}`, OPT);

const enroll = (fields) => Object.assign({ scenarioId: 'enroll', containerPath: [] }, fields);

// ---- Steps across step lists -------------------------------------------------------------------------------------

test('moveStep moves the first step of enroll into the alt\'s second branch and back', () => {
  const moved = applied(REFERENCE, Object.assign({ op: 'moveStep' }, enroll({ from: 0, to: 1, toContainerPath: [2, 'alt', 1] })));

  assert.equal(moved.text, replaced(replaced(REFERENCE, FIRST, ''), REPLY, `${REPLY}              - web -> coordinator: submits the plan to\n`));
  assert.deepEqual(stepSummary(moved.text, 'enroll'), [
    'coordinator->policy',
    'alt[eligible: coordinator->seats, coordinator->billing-gateway | not eligible: coordinator->web, web->coordinator]',
  ]);
  const back = applied(moved.text, { op: 'moveStep', scenarioId: 'enroll', containerPath: [1, 'alt', 1], from: 1, to: 0, toContainerPath: [] });
  assert.equal(back.text, REFERENCE, 'moving the step back gives the text back');
});

test('a fragment moved into its own branch is fragment-into-itself', () => {
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'moveStep' }, enroll({ from: 2, to: 0, toContainerPath: [2, 'alt', 0] }))),
    'fragment-into-itself');
});

test('moveStep without toContainerPath, or with the list it starts in, reorders that list as before', () => {
  const expected = replaced(REFERENCE, FIRST + SECOND, SECOND + FIRST);
  assert.equal(applied(REFERENCE, Object.assign({ op: 'moveStep' }, enroll({ from: 0, to: 1 }))).text, expected);
  assert.equal(applied(REFERENCE, Object.assign({ op: 'moveStep' }, enroll({ from: 0, to: 1, toContainerPath: [] }))).text, expected);
});

test('a step written as a flow map keeps its form and its inline comment when it moves into a branch', () => {
  const flowStep = '{from: web, to: coordinator, description: submits the plan to}  # the first request';
  const commented = replaced(REFERENCE, FIRST, `      - ${flowStep}\n`);

  const moved = applied(commented, Object.assign({ op: 'moveStep' }, enroll({ from: 0, to: 1, toContainerPath: [2, 'alt', 1] })));

  assert.equal(moved.text, replaced(replaced(commented, `      - ${flowStep}\n`, ''), REPLY, `${REPLY}              - ${flowStep}\n`));
});

test('a step whose written form a flow-style step list cannot take is written there from its data', () => {
  const mapForm = '      - from: web\n        to: coordinator\n        description: submits the plan to\n';
  const flowBranch = replaced(replaced(REFERENCE, FIRST, mapForm), NOT_ELIGIBLE,
    '          - when: not eligible\n            steps: [{coordinator -> web: reports the refusal and its reason to}]\n');

  const moved = applied(flowBranch, Object.assign({ op: 'moveStep' }, enroll({ from: 0, to: 0, toContainerPath: [2, 'alt', 1] })));

  assert.equal(moved.text, replaced(replaced(flowBranch, mapForm, ''), 'steps: [{coordinator -> web',
    'steps: [{from: web, to: coordinator, description: submits the plan to}, {coordinator -> web'));
  assert.deepEqual(stepSummary(moved.text, 'enroll'), [
    'coordinator->policy',
    'alt[eligible: coordinator->seats, coordinator->billing-gateway | not eligible: web->coordinator, coordinator->web]',
  ]);
});

// ---- Wrapping and unwrapping -------------------------------------------------------------------------------------

test('wrapSteps puts steps 0 and 1 into a new opt', () => {
  const wrapped = applied(REFERENCE, Object.assign({ op: 'wrapSteps' }, enroll({ from: 0, to: 1, operator: 'opt' })));

  assert.equal(wrapped.text, replaced(REFERENCE, FIRST + SECOND, [
    '      - opt:\n',
    '          when: ""\n',
    '          steps:\n',
    '            - web -> coordinator: submits the plan to\n',
    '            - coordinator -> policy: asks for an eligibility decision from\n',
  ].join('')));
  const unwrapped = applied(wrapped.text, Object.assign({ op: 'unwrapFragment' }, enroll({ index: 0 })));
  assert.equal(unwrapped.text, REFERENCE, 'unwrapping the new opt gives the text back');
});

test('unwrapFragment replaces the alt by its steps in order', () => {
  const unwrapped = applied(REFERENCE, Object.assign({ op: 'unwrapFragment' }, enroll({ index: 2 })));

  assert.equal(unwrapped.text, replaced(REFERENCE, ALT, [
    '      - coordinator -> seats: reserves all seats or none through\n',
    '      - coordinator -> billing-gateway: asks for tuition charges through\n',
    '      - coordinator -> web: reports the refusal and its reason to\n',
  ].join('')));
});

test('wrapping and unwrapping keep the comments inside the steps they move', () => {
  const commented = replaced(REFERENCE, NOT_ELIGIBLE, `          # the policy refused\n${NOT_ELIGIBLE}`);

  const wrapped = applied(commented, Object.assign({ op: 'wrapSteps' }, enroll({ from: 2, to: 2, operator: 'loop' })));

  assert.match(wrapped.text, /\n {16}# the policy refused\n {16}- when: not eligible\n/, 'the comment moves with the alt, three levels deeper');
  assert.equal(applied(wrapped.text, Object.assign({ op: 'unwrapFragment' }, enroll({ index: 2 }))).text, commented);
});

test('wrapSteps refuses an operator that is not a fragment and a range that runs backwards', () => {
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'wrapSteps' }, enroll({ from: 0, to: 1, operator: 'critical' }))), 'invalid-operator');
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'wrapSteps' }, enroll({ from: 1, to: 0, operator: 'opt' }))), 'invalid-index');
});

test('unwrapFragment of a message step is not-a-fragment', () => {
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'unwrapFragment' }, enroll({ index: 0 }))), 'not-a-fragment');
});

// ---- Fragment operators, branches, and guards --------------------------------------------------------------------

test('setFragmentOperator from a two-branch alt to opt is single-branch', () => {
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'setFragmentOperator' }, enroll({ index: 2, operator: 'opt' }))), 'single-branch');
});

test('setFragmentOperator turns the alt into a par and back', () => {
  const par = applied(REFERENCE, Object.assign({ op: 'setFragmentOperator' }, enroll({ index: 2, operator: 'par' })));

  assert.equal(par.text, replaced(REFERENCE, '      - alt:\n', '      - par:\n'));
  assert.equal(applied(par.text, Object.assign({ op: 'setFragmentOperator' }, enroll({ index: 2, operator: 'alt' }))).text, REFERENCE);
});

test('setFragmentOperator turns a one-branch alt into an opt and back', () => {
  const opt = applied(ONE_BRANCH, Object.assign({ op: 'setFragmentOperator' }, enroll({ index: 2, operator: 'opt' })));

  assert.equal(opt.text, WITH_OPT);
  assert.equal(applied(opt.text, Object.assign({ op: 'setFragmentOperator' }, enroll({ index: 2, operator: 'alt' }))).text, ONE_BRANCH);
});

test('a branch keeps its comments when its fragment changes between a list of branches and one branch', () => {
  const note = '              # all seats or none\n';
  const commented = replaced(ONE_BRANCH, '              - coordinator -> seats:', `${note}              - coordinator -> seats:`);

  const opt = applied(commented, Object.assign({ op: 'setFragmentOperator' }, enroll({ index: 2, operator: 'opt' })));

  assert.equal(opt.text, replaced(WITH_OPT, '            - coordinator -> seats:', '            # all seats or none\n            - coordinator -> seats:'));
  assert.equal(applied(opt.text, Object.assign({ op: 'setFragmentOperator' }, enroll({ index: 2, operator: 'alt' }))).text, commented);
});

test('addBranch on an opt is single-branch', () => {
  assert.equal(refusalOf(WITH_OPT, Object.assign({ op: 'addBranch' }, enroll({ index: 2, when: 'the plan is on hold' }))), 'single-branch');
});

test('addBranch adds a branch to the alt, and removeBranch takes it away again', () => {
  const added = applied(REFERENCE, Object.assign({ op: 'addBranch' }, enroll({ index: 2, when: 'the plan is on hold' })));

  assert.equal(added.text, replaced(REFERENCE, REPLY, `${REPLY}          - when: the plan is on hold\n`));
  assert.equal(applied(added.text, Object.assign({ op: 'removeBranch' }, enroll({ index: 2, branch: 2 }))).text, REFERENCE);
});

test('a new branch without a guard is empty-guard', () => {
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'addBranch' }, enroll({ index: 2, when: ' ' }))), 'empty-guard');
});

test('removeBranch of a fragment\'s only branch is last-branch', () => {
  assert.equal(refusalOf(ONE_BRANCH, Object.assign({ op: 'removeBranch' }, enroll({ index: 2, branch: 0 }))), 'last-branch');
  assert.equal(refusalOf(WITH_OPT, Object.assign({ op: 'removeBranch' }, enroll({ index: 2, branch: 0 }))), 'last-branch');
});

test('setBranchGuard to empty text is empty-guard', () => {
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'setBranchGuard' }, enroll({ index: 2, branch: 1, when: '' }))), 'empty-guard');
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'setBranchGuard' }, enroll({ index: 2, branch: 1, when: '   ' }))), 'empty-guard');
});

test('setBranchGuard rewrites the guard of one branch only, and back', () => {
  const guarded = applied(REFERENCE, Object.assign({ op: 'setBranchGuard' }, enroll({ index: 2, branch: 1, when: 'the student is not eligible' })));

  assert.equal(guarded.text, replaced(REFERENCE, '          - when: not eligible\n', '          - when: the student is not eligible\n'));
  assert.equal(applied(guarded.text, Object.assign({ op: 'setBranchGuard' }, enroll({ index: 2, branch: 1, when: 'not eligible' }))).text,
    REFERENCE);
});

test('the step commands keep Windows line breaks', () => {
  const windows = (text) => text.replace(/\n/g, '\r\n');
  const commands = [
    Object.assign({ op: 'moveStep' }, enroll({ from: 0, to: 1, toContainerPath: [2, 'alt', 1] })),
    Object.assign({ op: 'wrapSteps' }, enroll({ from: 0, to: 1, operator: 'opt' })),
    Object.assign({ op: 'unwrapFragment' }, enroll({ index: 2 })),
  ];
  for (const command of commands) {
    assert.doesNotMatch(applied(windows(REFERENCE), command).text, /(^|[^\r])\n/, `${command.op} writes only \\r\\n`);
  }
  const opt = applied(windows(ONE_BRANCH), Object.assign({ op: 'setFragmentOperator' }, enroll({ index: 2, operator: 'opt' })));
  assert.equal(opt.text, windows(WITH_OPT));
});

// ---- Deployment nodes --------------------------------------------------------------------------------------------

const API_POD = 'api-pod: {name: API pod, kind: environment, technology: Docker, instances: 3, hosts: [api]}\n';
const POSTGRES = 'postgres: {name: Managed database, kind: environment, technology: PostgreSQL 16, hosts: [db]}\n';
const DATA_CENTRE_END = '        hosts: [billing]\n';
const INGRESS_LINK = '            collaborators:\n              api-pod: forwards HTTPS requests to\n';

const production = (fields) => Object.assign({ environmentId: 'production' }, fields);

test('moveNode takes api-pod to the top level and into data-centre', () => {
  const top = applied(REFERENCE, Object.assign({ op: 'moveNode' }, production({ nodeId: 'api-pod', newParentNodeId: null })));

  assert.equal(top.text, replaced(replaced(REFERENCE, `          ${API_POD}`, ''), DATA_CENTRE_END, `${DATA_CENTRE_END}      ${API_POD}`));
  assert.equal(nodeOf(top.text, 'api-pod').parentId, null);

  const inside = applied(top.text, Object.assign({ op: 'moveNode' }, production({ nodeId: 'api-pod', newParentNodeId: 'data-centre' })));

  assert.equal(inside.text, replaced(REFERENCE.replace(`          ${API_POD}`, ''), DATA_CENTRE_END,
    `${DATA_CENTRE_END}        nodes:\n          ${API_POD}`));
  assert.equal(nodeOf(inside.text, 'api-pod').parentId, 'data-centre');
});

test('moveNode of the last node of campus-cloud to the top level and back gives the text back', () => {
  const top = applied(REFERENCE, Object.assign({ op: 'moveNode' }, production({ nodeId: 'postgres', newParentNodeId: null })));
  const back = applied(top.text, Object.assign({ op: 'moveNode' }, production({ nodeId: 'postgres', newParentNodeId: 'campus-cloud' })));

  assert.equal(nodeOf(top.text, 'postgres').parentId, null);
  assert.equal(back.text, REFERENCE);
  assert.ok(REFERENCE.includes(`          ${POSTGRES}`), 'postgres is a node of campus-cloud in the reference model');
});

test('moving the pinned top-level laptop into campus-cloud removes laptop\'s position', () => {
  const pinned = withLayout(REFERENCE, 'deployment production:', '  positions:', '    laptop: [40, 40]', '    campus-cloud: [300, 40]');

  const moved = applied(pinned, Object.assign({ op: 'moveNode' }, production({ nodeId: 'laptop', newParentNodeId: 'campus-cloud' })));

  assert.equal(nodeOf(moved.text, 'laptop').parentId, 'campus-cloud');
  assert.deepEqual(dataAt(moved.text, ['layout', 'deployment production', 'positions']), { 'campus-cloud': ['300', '40'] });
});

test('campus-cloud into api-pod is node-into-itself and api-pod into ingress is infrastructure-leaf', () => {
  const move = (nodeId, newParentNodeId) => refusalOf(REFERENCE, Object.assign({ op: 'moveNode' }, production({ nodeId, newParentNodeId })));
  assert.equal(move('campus-cloud', 'api-pod'), 'node-into-itself');
  assert.equal(move('campus-cloud', 'campus-cloud'), 'node-into-itself');
  assert.equal(move('api-pod', 'ingress'), 'infrastructure-leaf');
});

test('setNodeLink from laptop to campus-cloud adds a collaborator, and again is link-exists', () => {
  const link = production({ nodeId: 'laptop', targetNodeId: 'campus-cloud', description: 'sends HTTPS requests to', technology: 'HTTPS' });

  const added = applied(REFERENCE, Object.assign({ op: 'setNodeLink' }, link));

  assert.ok(added.edits.every((edit) => edit.length === 0), 'a new link only inserts text');
  const [only, ...others] = nodeOf(added.text, 'laptop').relationships;
  assert.deepEqual(others, []);
  assert.deepEqual([only.targetId, only.description, only.technology], ['campus-cloud', 'sends HTTPS requests to', 'HTTPS']);
  assert.equal(refusalOf(added.text, Object.assign({ op: 'setNodeLink' }, link)), 'link-exists');
  assert.equal(applied(added.text, { op: 'removeNodeLink', environmentId: 'production', nodeId: 'laptop', targetNodeId: 'campus-cloud' }).text,
    REFERENCE, 'removing the new link gives the text back');
});

test('setNodeLink with replace rewrites the link a node has, and refuses a link the node does not have', () => {
  const rewrite = production({ nodeId: 'ingress', targetNodeId: 'api-pod', description: 'balances HTTPS requests across', technology: 'HTTPS',
    replace: true });

  const rewritten = applied(REFERENCE, Object.assign({ op: 'setNodeLink' }, rewrite));

  const [only, ...others] = nodeOf(rewritten.text, 'ingress').relationships;
  assert.deepEqual(others, []);
  assert.deepEqual([only.targetId, only.description, only.technology], ['api-pod', 'balances HTTPS requests across', 'HTTPS']);
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'setNodeLink' }, rewrite, { nodeId: 'laptop' })), 'unknown-link');
});

test('setNodeLink from laptop to laptop is link-self', () => {
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'setNodeLink' },
    production({ nodeId: 'laptop', targetNodeId: 'laptop', description: 'talks to itself' }))), 'link-self');
});

test('removeNodeLink removes ingress\'s link to api-pod', () => {
  const removed = applied(REFERENCE, { op: 'removeNodeLink', environmentId: 'production', nodeId: 'ingress', targetNodeId: 'api-pod' });

  assert.equal(removed.text, replaced(REFERENCE, INGRESS_LINK, ''));
  assert.deepEqual(nodeOf(removed.text, 'ingress').relationships, []);
  const back = applied(removed.text, Object.assign({ op: 'setNodeLink' },
    production({ nodeId: 'ingress', targetNodeId: 'api-pod', description: 'forwards HTTPS requests to' })));
  assert.equal(back.text, REFERENCE, 'adding the link again gives the text back');
  assert.equal(refusalOf(removed.text, { op: 'removeNodeLink', environmentId: 'production', nodeId: 'ingress', targetNodeId: 'api-pod' }),
    'unknown-link');
});

test('removeNodeLink takes the stored bend of that link with it', () => {
  const bent = withLayout(REFERENCE, 'deployment production:', '  routes:',
    '    - {from: ingress, to: api-pod, relation: link, points: [[520, 150], [560, 185]]}');

  const removed = applied(bent, { op: 'removeNodeLink', environmentId: 'production', nodeId: 'ingress', targetNodeId: 'api-pod' });

  assert.equal(removed.text, replaced(REFERENCE, INGRESS_LINK, ''), 'the route, its entry, and the layout section go');
});

// ---- Node ids ----------------------------------------------------------------------------------------------------

const NAMED = withLayout(REFERENCE, 'deployment production:', '  positions:', '    api-pod: [300, 40]', '  routes:',
  '    - {from: ingress, to: api-pod, relation: link, points: [[520, 150], [560, 185]]}',
  '    - {from: web@browser, to: api@api-pod, relation: derived, points: [[100, 100], [200, 200]]}');
const STAGING = [
  '  staging:\n',
  '    name: Staging\n',
  '    nodes:\n',
  '      gateway:\n',
  '        name: Gateway\n',
  '        collaborators:\n',
  '          api-pod: forwards requests to\n',
  '      api-pod: {name: API pod, kind: environment}\n',
].join('');
const WITH_STAGING = replaced(REFERENCE, DATA_CENTRE_END, DATA_CENTRE_END + STAGING);

test('changeNodeId renames api-pod to api-workers in its key, in ingress\'s link to it, in its position, in the end of the link\'s stored bend, '
  + 'and in the instance key of a derived path', () => {
  const renamed = applied(NAMED, Object.assign({ op: 'changeNodeId' }, production({ nodeId: 'api-pod', newId: 'api-workers' })));

  const expected = [
    ['          api-pod: {name: API pod', '          api-workers: {name: API pod'],
    ['              api-pod: forwards HTTPS requests to', '              api-workers: forwards HTTPS requests to'],
    ['      api-pod: [300, 40]', '      api-workers: [300, 40]'],
    ['{from: ingress, to: api-pod, relation: link', '{from: ingress, to: api-workers, relation: link'],
    ['to: api@api-pod, relation: derived', 'to: api@api-workers, relation: derived'],
  ].reduce((text, [from, to]) => replaced(text, from, to), NAMED);
  assert.equal(renamed.text, expected);
});

test('changeNodeId and back restores the text', () => {
  const renamed = applied(NAMED, Object.assign({ op: 'changeNodeId' }, production({ nodeId: 'api-pod', newId: 'api-workers' })));
  const back = applied(renamed.text, Object.assign({ op: 'changeNodeId' }, production({ nodeId: 'api-workers', newId: 'api-pod' })));

  assert.equal(back.text, NAMED);
});

test('changeNodeId to the id a node has changes nothing', () => {
  const same = applied(REFERENCE, Object.assign({ op: 'changeNodeId' }, production({ nodeId: 'api-pod', newId: 'api-pod' })));

  assert.equal(same.text, REFERENCE);
  assert.deepEqual(same.edits, []);
});

test('an id another node of production has is id-taken, and the same id in another environment is accepted', () => {
  assert.equal(refusalOf(WITH_STAGING, Object.assign({ op: 'changeNodeId' }, production({ nodeId: 'api-pod', newId: 'postgres' }))), 'id-taken');

  const renamed = applied(WITH_STAGING, Object.assign({ op: 'changeNodeId' }, production({ nodeId: 'api-pod', newId: 'gateway' })));

  assert.equal(nodeOf(renamed.text, 'gateway').name, 'API pod');
  assert.equal(load(renamed.text).model.environments.get('staging').nodes.get('gateway').name, 'Gateway');
});

test('changeNodeId leaves the nodes of another environment alone', () => {
  const renamed = applied(WITH_STAGING, Object.assign({ op: 'changeNodeId' }, production({ nodeId: 'api-pod', newId: 'api-workers' })));

  assert.ok(renamed.text.includes(STAGING), 'staging keeps its api-pod and its link to it');
  assert.equal(nodeOf(renamed.text, 'api-workers').name, 'API pod');
});

test('"api pod" is invalid-id', () => {
  assert.equal(refusalOf(REFERENCE, Object.assign({ op: 'changeNodeId' }, production({ nodeId: 'api-pod', newId: 'api pod' }))), 'invalid-id');
});

// ---- Selectors that name an interface's card ---------------------------------------------------------------------

test('interfaceSelectorsOf lists the initial view and a custom view whose selector is "interface Enrollment-API", '
  + 'and nothing for an interface no selector names', () => {
  const selecting = load(`${INTERFACES}view: interface enrollment-api\nviews:\n  card:\n    view: interface Enrollment-API\n`
    + '  overview:\n    view: containers of registration\n');

  assert.deepEqual(core.interfaceSelectorsOf(selecting, 'enrollment-api'), [
    { path: ['view'], label: 'The initial view' },
    { path: ['views', 'card', 'view'], label: 'View card' },
  ]);
  assert.deepEqual(core.interfaceSelectorsOf(selecting, 'tuition-charges'), []);
  assert.deepEqual(core.interfaceSelectorsOf(load('a: [unclosed\n'), 'enrollment-api'), [], 'a design that cannot be read names none');
});
