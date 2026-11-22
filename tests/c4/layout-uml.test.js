'use strict';

// Layout entries of UML-notation views (UML-view editing spec §4.2, §4.3, §6): the named parts each view type keeps,
// how toUml writes them into the ArchUML text, the setUmlLayout command, and what Change id and the removals do to them,
// so that a thing which later takes a removed thing's id inherits no pin, bend, or lifeline place (Review Focus 3).
const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('../../vendor/yaml/2.9.1/yaml.js');
const yamlAdapter = require('../../c4/c4-yaml.js');
const { loadCore, fixture } = require('./helpers.js');

const core = loadCore();
const REFERENCE = fixture('course-registration.yml');
const INTERFACES = fixture('course-registration-interfaces.yml');

const load = (text) => core.load(text, { source: 'file' });

/** `text` with a `layout:` section appended whose lines are `entryLines`, each indented below `layout:`. */
function withLayout(text, ...entryLines) {
  return `${text.replace(/\n*$/, '\n')}layout:\n${entryLines.map((line) => `  ${line}\n`).join('')}`;
}

/** `text` with `from` replaced by `to`; fails when `from` is absent, so an edit cannot silently miss. */
function replaced(text, from, to) {
  assert.ok(text.includes(from), `the model text contains ${from}`);
  return text.replace(from, to);
}

/** Applies `command` to `text`; fails unless the command succeeds and its edits produce its text. */
function applied(text, command) {
  const result = core.edit(load(text), command);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(yamlAdapter.applyEdits(text, result.edits), result.text, 'the edits turn the input into the returned text');
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

/** The reader's diagnostics at `layout` paths, each as `[rule, path]`. */
function layoutDiagnostics(text) {
  return load(text).diagnostics.filter((found) => found.path && found.path[0] === 'layout').map((found) => [found.rule, found.path]);
}

/** The layout entry the projection attaches to a view, with its positions as `[id, [x, y]]` pairs. */
function layoutOf(text, selector) {
  const { layout } = core.project(load(text), selector);
  return layout && { positions: [...layout.positions], routes: layout.routes, lifelines: layout.lifelines };
}

/** The lines of a toUml text from `@layout` to `@endlayout`, or [] without a layout block. */
function layoutBlock(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('@layout');
  return start < 0 ? [] : lines.slice(start, lines.indexOf('@endlayout') + 1);
}

/** The text without its layout block. */
function withoutBlock(text) {
  const block = layoutBlock(text);
  return block.length === 0 ? text : text.replace(`${block.join('\n')}\n`, '');
}

/** The line of a toUml text whose source entry `matches` (the numbering of the renderers' `rel:N` ids). */
function lineOf(uml, matches) {
  const lines = uml.source.lines.flatMap((entry, index) => (entry && matches(entry) ? [index] : []));
  assert.equal(lines.length, 1, 'one line matches');
  return lines[0];
}

const umlOf = (text, selector) => core.toUml(core.project(load(text), selector));
const route = (from, to, relation, points) => ({ from, to, relation, points });

// ---- Reading: the parts each view type keeps (spec §4.2) ---------------------------------------------------------------

const DEPLOYMENT_ENTRY = [
  'deployment production:',
  '  positions:',
  '    campus-cloud: [300, 40]',
  '  routes:',
  '    - {from: ingress, to: api-pod, relation: link, points: [[520, 150], [560, 185], [520, 220]]}',
  '    - {from: web@browser, to: api@api-pod, relation: derived, points: [[100, 300], [400, 300]]}',
];

const READ_PARTS = [
  { type: 'code', text: withLayout(REFERENCE, 'code of policy:', '  positions:', '    EnrollmentPolicy: [80, 40]', '  routes:',
    '    - {from: EnrollmentPolicy, to: EnrollmentRule, relation: collaborator, points: [[380, 90], [400, 60.5], [420, 90]]}'),
  selector: 'code of policy', expected: {
    positions: [['EnrollmentPolicy', [80, 40]]],
    routes: [route('EnrollmentPolicy', 'EnrollmentRule', 'collaborator', [[380, 90], [400, 60.5], [420, 90]])], lifelines: [],
  } },
  { type: 'deployment', text: withLayout(REFERENCE, ...DEPLOYMENT_ENTRY), selector: 'deployment production', expected: {
    positions: [['campus-cloud', [300, 40]]],
    routes: [route('ingress', 'api-pod', 'link', [[520, 150], [560, 185], [520, 220]]),
      route('web@browser', 'api@api-pod', 'derived', [[100, 300], [400, 300]])], lifelines: [],
  } },
  { type: 'interfaces', text: withLayout(INTERFACES, 'interfaces of api:', '  positions: {web: [60, 40], api: [60, 260], billing: [440, 260]}'),
    selector: 'interfaces of api', expected: { positions: [['web', [60, 40]], ['api', [60, 260]], ['billing', [440, 260]]], routes: [], lifelines: [] } },
  { type: 'dynamic', text: withLayout(REFERENCE, 'dynamic enroll:', '  lifelines: [web, policy, coordinator, seats, billing-gateway]'),
    selector: 'dynamic enroll', expected: { positions: [], routes: [], lifelines: ['web', 'policy', 'coordinator', 'seats', 'billing-gateway'] } },
];

READ_PARTS.forEach(({ type, text, selector, expected }) => {
  test(`the parts of a ${type} view are read without a diagnostic and attached to its view model`, () => {
    assert.deepEqual(layoutDiagnostics(text), []);
    assert.deepEqual(layoutOf(text, selector), expected);
  });
});

test('a UML view without a layout entry has layout null, and a C4 view keeps its pin map', () => {
  const text = withLayout(REFERENCE, 'containers of registration:', '  web: [40, 120]');
  assert.equal(core.project(load(text), 'code of policy').layout, null);
  assert.deepEqual([...load(text).model.layout.get('containers of registration')], [['web', [40, 120]]]);
});

test('a custom view keeps the parts of the view it is based on', () => {
  const text = withLayout(`${REFERENCE.replace(/\n*$/, '\n')}views:\n  rules:\n    view: code of policy\n`,
    'rules:', '  positions: {EnrollmentRule: [420, 40]}');
  assert.deepEqual(layoutDiagnostics(text), []);
  assert.deepEqual(layoutOf(text, 'rules').positions, [['EnrollmentRule', [420, 40]]]);
});

test('a flat pin map under a UML view key is schema/type with a hint', () => {
  const text = withLayout(REFERENCE, 'code of policy:', '  EnrollmentPolicy: [80, 40]');
  const [found, ...others] = load(text).diagnostics.filter((diagnostic) => diagnostic.path && diagnostic.path[0] === 'layout');
  assert.deepEqual(others, []);
  assert.deepEqual([found.rule, found.severity, found.path], ['schema/type', 'error', ['layout', 'code of policy']]);
  assert.match(found.hint, /positions/);
  assert.deepEqual(layoutOf(text, 'code of policy').positions, [], 'the pins are not read as positions');
});

test('lifelines under a code key is schema/unknown-key', () => {
  const text = withLayout(REFERENCE, 'code of policy:', '  positions: {EnrollmentPolicy: [80, 40]}', '  lifelines: [EnrollmentPolicy]');
  assert.deepEqual(layoutDiagnostics(text), [['schema/unknown-key', ['layout', 'code of policy', 'lifelines']]]);
  assert.deepEqual(layoutOf(text, 'code of policy').positions, [['EnrollmentPolicy', [80, 40]]], 'the known part is still read');
});

test('positions under an interfaces view key are accepted, and routes or lifelines there are schema/unknown-key', () => {
  const text = withLayout(INTERFACES, 'interfaces of api:', '  positions: {api: [60, 260]}',
    '  routes:', '    - {from: web, to: api, relation: collaborator, points: [[0, 0], [10, 10]]}', '  lifelines: [web]');
  assert.deepEqual(layoutDiagnostics(text), [
    ['schema/unknown-key', ['layout', 'interfaces of api', 'routes']],
    ['schema/unknown-key', ['layout', 'interfaces of api', 'lifelines']],
  ]);
  assert.deepEqual(layoutOf(text, 'interfaces of api'), { positions: [['api', [60, 260]]], routes: [], lifelines: [] });
});

test('a route needs two points and a relation its view draws', () => {
  const text = withLayout(REFERENCE, 'code of policy:', '  routes:',
    '    - {from: EnrollmentPolicy, to: EnrollmentRule, relation: collaborator, points: [[380, 90]]}',
    '    - {from: PrerequisiteRule, to: EnrollmentRule, relation: implements, points: [[0, 0], [1, 1]]}',
    '    - {from: EnrollmentPolicy, to: EnrollmentRule, relation: collaborator}');
  assert.deepEqual(layoutDiagnostics(text).map(([rule]) => rule), ['schema/type', 'schema/value', 'schema/type']);
  assert.deepEqual(layoutOf(text, 'code of policy').routes, [], 'no malformed route is read');
});

// ---- toUml: the layout block and the lifeline order (spec §6) ---------------------------------------------------------

test('toUml writes the layout block after @startuml and leaves the route ids unchanged', () => {
  const plain = umlOf(REFERENCE, 'code of policy');
  const pinned = umlOf(withLayout(REFERENCE, 'code of policy:', '  positions:', '    EnrollmentPolicy: [80, 40]', '    EnrollmentRule: [420, 40.5]',
    '  routes:', '    - {from: EnrollmentPolicy, to: EnrollmentRule, relation: collaborator, points: [[380, 90], [400, 60], [420, 90]]}'), 'code of policy');
  const dependency = lineOf(plain, (entry) => entry.kind === 'relation' && entry.relation === 'collaborator');
  assert.deepEqual(pinned.text.split('\n').slice(0, 6), ['@startuml', '@layout', 'node "EnrollmentPolicy" x=80 y=40',
    'node "EnrollmentRule" x=420 y=40.5', `edge "rel:${dependency}" points="380,90 400,60 420,90"`, '@endlayout']);
  assert.equal(withoutBlock(pinned.text), plain.text, 'outside its layout block the text is unchanged');
  assert.deepEqual(pinned.source, plain.source, 'the source map counts the lines without the layout block, as the renderers do');
  assert.deepEqual(pinned.ids, plain.ids);
});

test('toUml writes the positions of top-level nodes and the routes of links and derived paths of a deployment view', () => {
  const plain = umlOf(REFERENCE, 'deployment production');
  const pinned = umlOf(withLayout(REFERENCE, ...DEPLOYMENT_ENTRY), 'deployment production');
  const link = lineOf(plain, (entry) => entry.kind === 'link' && entry.from === 'ingress');
  const derived = lineOf(plain, (entry) => entry.kind === 'link' && entry.from === 'web@browser');
  assert.deepEqual(layoutBlock(pinned.text), ['@layout', 'node "campus_cloud" x=300 y=40',
    `edge "rel:${link}" points="520,150 560,185 520,220"`, `edge "rel:${derived}" points="100,300 400,300"`, '@endlayout']);
  assert.equal(withoutBlock(pinned.text), plain.text);
});

test('toUml leaves out what the view does not draw and what holds no position', () => {
  const text = withLayout(REFERENCE,
    'deployment production:',
    '  positions: {nowhere: [1, 1], browser: [1200, 700], api@api-pod: [5, 5]}',
    '  routes:',
    '    - {from: laptop, to: data-centre, relation: link, points: [[0, 0], [10, 10]]}',
    '    - {from: ingress, to: api-pod, relation: derived, points: [[0, 0], [10, 10]]}',
    'code of policy:',
    '  positions: {Ghost: [1, 1]}',
    '  routes:',
    '    - {from: PrerequisiteRule, to: EnrollmentRule, relation: collaborator, points: [[0, 0], [10, 10]]}');
  assert.equal(umlOf(text, 'deployment production').text, umlOf(REFERENCE, 'deployment production').text,
    'an unknown box, a nested node, a hosted instance, a link the view does not draw, and a derived path between nodes');
  assert.equal(umlOf(text, 'code of policy').text, umlOf(REFERENCE, 'code of policy').text,
    'an unknown class, and a dependency where the view draws a realization');
});

test('two dependencies in one direction between one pair get no stored route', () => {
  const twice = replaced(REFERENCE, 'collaborators: {EnrollmentRule: asks each rule to evaluate the student with}',
    'collaborators: {EnrollmentRule: [asks each rule to evaluate the student with, counts the rules of]}');
  const text = withLayout(twice, 'code of policy:', '  routes:',
    '    - {from: EnrollmentPolicy, to: EnrollmentRule, relation: collaborator, points: [[380, 90], [420, 90]]}');
  const uml = umlOf(text, 'code of policy');
  assert.equal(uml.text.split('\n').filter((line) => line.startsWith('EnrollmentPolicy ..> EnrollmentRule')).length, 2);
  assert.equal(uml.text, umlOf(twice, 'code of policy').text, 'no layout block names either line');
});

test('toUml declares the lifelines in the stored order and keeps the lifelines of one box together', () => {
  const declared = (text) => umlOf(text, 'dynamic enroll').text.split('\n').filter((line) => /^(box|end box|participant)\b/.test(line));
  const plain = umlOf(REFERENCE, 'dynamic enroll');
  const ordered = umlOf(withLayout(REFERENCE, 'dynamic enroll:', '  lifelines: [policy, nowhere, web]'), 'dynamic enroll');
  assert.deepEqual(declared(withLayout(REFERENCE, 'dynamic enroll:', '  lifelines: [policy, nowhere, web]')), [
    'box "Registration API"', 'participant policy: Enrollment Policy', 'participant coordinator: Registration Coordinator',
    'participant seats: Seat Gateway', 'participant billing_gateway: Billing Gateway', 'end box',
    'box "Course Registration"', 'participant web: Planner Web App', 'end box',
  ]);
  assert.deepEqual(layoutBlock(ordered.text), [], 'a lifeline order is no layout block');
  assert.deepEqual(ordered.ids, plain.ids, 'no alias changes with the order');
  assert.deepEqual(ordered.text.split('\n').slice(11), plain.text.split('\n').slice(11), 'the messages keep their lines');
  assert.deepEqual(ordered.source.lines.slice(11), plain.source.lines.slice(11));
});

test('toUml of interfaces of api with positions writes "layout ports facing" after the direction line and one node line for each positioned box, and without positions gives today\'s text', () => {
  const plain = umlOf(INTERFACES, 'interfaces of api');
  const pinned = umlOf(withLayout(INTERFACES, 'interfaces of api:', '  positions: {web: [60, 40], billing: [440, 260], nowhere: [1, 1]}'),
    'interfaces of api');
  const plainLines = plain.text.split('\n');
  assert.equal(plainLines[1], 'layout vertical');
  assert.deepEqual(pinned.text.split('\n'), ['@startuml', '@layout', 'node "e1" x=60 y=40', 'node "e3" x=440 y=260', '@endlayout',
    'layout vertical', 'layout ports facing'].concat(plainLines.slice(2)));
  assert.deepEqual([pinned.ids.e1, pinned.ids.e3], ['web', 'billing']);
  assert.deepEqual(pinned.source.lines, [null, null, null].concat(plain.source.lines.slice(2)),
    'the source map counts the directive line, outside the layout block');

  const nothingDrawn = withLayout(INTERFACES, 'interfaces of api:', '  positions: {nowhere: [1, 1]}');
  assert.equal(umlOf(nothingDrawn, 'interfaces of api').text, plain.text);
  assert.equal(umlOf(withLayout(INTERFACES, 'interfaces of api: {}'), 'interfaces of api').text, plain.text);
});

// ---- setUmlLayout (spec §4.3) ------------------------------------------------------------------------------------------

const CODE_LAYOUT = {
  op: 'setUmlLayout', viewKey: 'code of policy',
  positions: { EnrollmentPolicy: [80, 40], EnrollmentRule: [420, 40] },
  routes: [route('EnrollmentPolicy', 'EnrollmentRule', 'collaborator', [[380, 90], [400, 60], [420, 90]])],
};

test('setUmlLayout writes one splice, keeps the bytes outside it, and add-then-remove restores the text', () => {
  const pins = '  # pins of the container view\n  containers of registration:\n    web: [40, 120]\n';
  const base = `${REFERENCE.replace(/\n*$/, '\n')}layout:\n${pins}`;
  const added = applied(base, CODE_LAYOUT);
  assert.equal(added.edits.length, 1, 'one splice');
  assert.ok(added.text.startsWith(base.slice(0, added.edits[0].offset)) && added.text.includes(pins), 'the C4 pins are kept as written');
  assert.deepEqual(dataAt(added.text, ['layout', 'code of policy']), {
    positions: { EnrollmentPolicy: ['80', '40'], EnrollmentRule: ['420', '40'] },
    routes: [{ from: 'EnrollmentPolicy', to: 'EnrollmentRule', relation: 'collaborator', points: [['380', '90'], ['400', '60'], ['420', '90']] }],
  });
  assert.deepEqual(layoutDiagnostics(added.text), []);

  const removed = applied(added.text, { op: 'setUmlLayout', viewKey: 'code of policy',
    positions: { EnrollmentPolicy: null, EnrollmentRule: null }, routes: [route('EnrollmentPolicy', 'EnrollmentRule', 'collaborator', null)] });
  assert.equal(removed.edits.length, 1, 'one splice');
  assert.equal(removed.text, base);
  assert.equal(applied(REFERENCE, CODE_LAYOUT).text.includes('layout:\n  code of policy:\n    positions:\n      EnrollmentPolicy: [80, 40]\n'), true,
    'a new layout section holds the entry in block style with each position as [x, y]');
  assert.equal(applied(applied(REFERENCE, CODE_LAYOUT).text, Object.assign({}, CODE_LAYOUT, { positions: null, routes: null })).text, REFERENCE,
    'parts given as null are removed, and so are the entry and the section they leave empty');
});

test('a position given as null removes that position only', () => {
  const pinned = applied(REFERENCE, CODE_LAYOUT).text;
  const result = applied(pinned, { op: 'setUmlLayout', viewKey: 'code of policy', positions: { EnrollmentPolicy: null } });
  assert.deepEqual(layoutOf(result.text, 'code of policy'), {
    positions: [['EnrollmentRule', [420, 40]]], routes: [route('EnrollmentPolicy', 'EnrollmentRule', 'collaborator', [[380, 90], [400, 60], [420, 90]])],
    lifelines: [],
  });
  assert.equal(result.text, pinned.replace('      EnrollmentPolicy: [80, 40]\n', ''));
});

test('a position merges by key and keeps the others', () => {
  const pinned = applied(REFERENCE, CODE_LAYOUT).text;
  const result = applied(pinned, { op: 'setUmlLayout', viewKey: 'code of policy', positions: { EnrollmentRule: [500, 60], UnitCapRule: [540, 300] } });
  assert.deepEqual(layoutOf(result.text, 'code of policy').positions,
    [['EnrollmentPolicy', [80, 40]], ['EnrollmentRule', [500, 60]], ['UnitCapRule', [540, 300]]]);
});

test('a route given with points null removes that route only', () => {
  const second = route('PrerequisiteRule', 'EnrollmentPolicy', 'collaborator', [[300, 300], [80, 100]]);
  const pinned = applied(applied(REFERENCE, CODE_LAYOUT).text, { op: 'setUmlLayout', viewKey: 'code of policy', routes: [second] }).text;
  assert.deepEqual(layoutOf(pinned, 'code of policy').routes, [CODE_LAYOUT.routes[0], second], 'a new route is added after the others');
  const result = applied(pinned, { op: 'setUmlLayout', viewKey: 'code of policy',
    routes: [route('EnrollmentPolicy', 'EnrollmentRule', 'collaborator', null)] });
  assert.deepEqual(layoutOf(result.text, 'code of policy'), {
    positions: [['EnrollmentPolicy', [80, 40]], ['EnrollmentRule', [420, 40]]], routes: [second], lifelines: [],
  });
});

test('a route given with new points replaces the points of the route with its ends and relation', () => {
  const pinned = applied(REFERENCE, CODE_LAYOUT).text;
  const moved = route('EnrollmentPolicy', 'EnrollmentRule', 'collaborator', [[380, 90], [420, 90]]);
  assert.deepEqual(layoutOf(applied(pinned, { op: 'setUmlLayout', viewKey: 'code of policy', routes: [moved] }).text, 'code of policy').routes, [moved]);
});

test('lifelines replace the stored order', () => {
  const ordered = applied(REFERENCE, { op: 'setUmlLayout', viewKey: 'dynamic enroll', lifelines: ['web', 'coordinator', 'policy'] }).text;
  assert.deepEqual(dataAt(ordered, ['layout', 'dynamic enroll']), { lifelines: ['web', 'coordinator', 'policy'] });
  const reordered = applied(ordered, { op: 'setUmlLayout', viewKey: 'dynamic enroll', lifelines: ['policy', 'web'] }).text;
  assert.deepEqual(layoutOf(reordered, 'dynamic enroll').lifelines, ['policy', 'web']);
  assert.equal(applied(reordered, { op: 'setUmlLayout', viewKey: 'dynamic enroll', lifelines: [] }).text, REFERENCE,
    'an empty order is pruned with its entry');
});

test('setUmlLayout with routes for an interfaces key is layout/part', () => {
  assert.equal(refusalOf(INTERFACES, { op: 'setUmlLayout', viewKey: 'interfaces of api',
    routes: [route('web', 'api', 'collaborator', [[0, 0], [10, 10]])] }), 'layout/part');
});

test('a part the view type lacks is layout/part', () => {
  assert.equal(refusalOf(REFERENCE, { op: 'setUmlLayout', viewKey: 'code of policy', lifelines: ['EnrollmentPolicy'] }), 'layout/part');
  assert.equal(refusalOf(REFERENCE, { op: 'setUmlLayout', viewKey: 'dynamic enroll', positions: { web: [1, 2] } }), 'layout/part');
  assert.equal(refusalOf(REFERENCE, { op: 'setUmlLayout', viewKey: 'containers of registration', positions: { web: [1, 2] } }), 'layout/part',
    'a C4-notation view keeps its pins through pinPosition');
});

test('a position for a nested node or a hosted instance is layout/inside-node', () => {
  const position = (id) => ({ op: 'setUmlLayout', viewKey: 'deployment production', positions: { [id]: [1200, 700] } });
  assert.equal(refusalOf(REFERENCE, position('browser')), 'layout/inside-node');
  assert.equal(refusalOf(REFERENCE, position('api@api-pod')), 'layout/inside-node');
  assert.equal(refusalOf(REFERENCE, position('api')), 'layout/inside-node');
  assert.equal(applied(REFERENCE, position('laptop')).error, undefined, 'a top-level node holds a position');
});

test('a route for an inheritance line is layout/inheritance-line', () => {
  assert.equal(refusalOf(REFERENCE, { op: 'setUmlLayout', viewKey: 'code of policy',
    routes: [route('PrerequisiteRule', 'EnrollmentRule', 'implements', [[300, 300], [420, 90]])] }), 'layout/inheritance-line');
  assert.equal(refusalOf(REFERENCE, { op: 'setUmlLayout', viewKey: 'code of policy',
    routes: [route('PrerequisiteRule', 'EnrollmentRule', 'extends', [[300, 300], [420, 90]])] }), 'layout/inheritance-line');
});

test('pinPosition and unpinPosition on a UML view key are layout/uml-view', () => {
  assert.equal(refusalOf(REFERENCE, { op: 'pinPosition', viewKey: 'code of policy', elementId: 'EnrollmentPolicy', x: 80, y: 40 }), 'layout/uml-view');
  assert.equal(refusalOf(REFERENCE, { op: 'unpinPosition', viewKey: 'Code of policy with patterns', elementId: 'EnrollmentPolicy' }), 'layout/uml-view');
  assert.equal(refusalOf(REFERENCE, { op: 'pinPosition', viewKey: 'containers of registration', elementId: 'web', x: 40, y: 120 }), undefined);
});

test('setUmlLayout refuses malformed values and names it does not know', () => {
  const layout = (fields) => Object.assign({ op: 'setUmlLayout', viewKey: 'code of policy' }, fields);
  assert.equal(refusalOf(REFERENCE, layout({ positions: { EnrollmentPolicy: [80] } })), 'invalid-position');
  assert.equal(refusalOf(REFERENCE, layout({ positions: { Ghost: [80, 40] } })), 'unknown-element');
  assert.equal(refusalOf(REFERENCE, layout({ routes: [route('EnrollmentPolicy', 'EnrollmentRule', 'collaborator', [[1, 2]])] })), 'invalid-route');
  assert.equal(refusalOf(REFERENCE, layout({ routes: [route('EnrollmentPolicy', 'EnrollmentRule', 'collaborator', [[1, 2], [3]])] })), 'invalid-position');
  assert.equal(refusalOf(REFERENCE, layout({ routes: [route('EnrollmentPolicy', 'EnrollmentRule', 'link', [[1, 2], [3, 4]])] })), 'invalid-relation');
  assert.equal(refusalOf(REFERENCE, { op: 'setUmlLayout', viewKey: 'deployment production',
    routes: [route('ingress', 'nowhere', 'link', [[1, 2], [3, 4]])] }), 'unknown-node');
  assert.equal(refusalOf(REFERENCE, { op: 'setUmlLayout', viewKey: 'deployment production',
    routes: [route('web@nowhere', 'api@api-pod', 'derived', [[1, 2], [3, 4]])] }), 'unknown-node');
  assert.equal(refusalOf(REFERENCE, { op: 'setUmlLayout', viewKey: 'dynamic enroll', lifelines: ['web', 'nowhere'] }), 'unknown-element');
  assert.equal(refusalOf(REFERENCE, { op: 'setUmlLayout', viewKey: 'code of', positions: {} }), 'invalid-view');
  assert.equal(applied(REFERENCE, layout({ positions: { Ghost: null } })).edits.length, 0, 'removing what is not stored changes nothing');
});

// ---- Identity and orphans (spec §4.2, Review Focus 3) -----------------------------------------------------------------

test('changeElementId rewrites the position key of an interfaces entry, and deleting the element removes it', () => {
  const text = withLayout(INTERFACES, 'interfaces of api:', '  positions:', '    web: [60, 40]', '    api: [60, 260]', '    billing: [440, 260]');
  const renamed = applied(text, { op: 'changeElementId', elementId: 'web', newId: 'planner' }).text;
  assert.deepEqual(layoutOf(renamed, 'interfaces of api').positions, [['planner', [60, 40]], ['api', [60, 260]], ['billing', [440, 260]]]);
  const deleted = applied(renamed, { op: 'deleteElement', elementId: 'billing' }).text;
  assert.deepEqual(layoutOf(deleted, 'interfaces of api').positions, [['planner', [60, 40]], ['api', [60, 260]]]);
  assert.deepEqual(layoutDiagnostics(deleted), []);
});

test('changeElementId rewrites every layout site', () => {
  const text = withLayout(REFERENCE,
    'interfaces of api:',
    '  positions: {web: [60, 40], api: [60, 260]}',
    'deployment production:',
    '  positions: {campus-cloud: [300, 40]}',
    '  routes:',
    '    - {from: web@browser, to: api@api-pod, relation: derived, points: [[1, 2], [3, 4]]}',
    '    - {from: api@api-pod, to: db@postgres, relation: derived, points: [[5, 6], [7, 8]]}',
    '    - {from: ingress, to: api-pod, relation: link, points: [[9, 9], [9, 10]]}',
    'dynamic enroll:',
    '  lifelines: [web, api, coordinator]');
  const renamed = applied(text, { op: 'changeElementId', elementId: 'api', newId: 'registration-api' }).text;
  assert.deepEqual(dataAt(renamed, ['layout']), {
    'interfaces of registration-api': { positions: { web: ['60', '40'], 'registration-api': ['60', '260'] } },
    'deployment production': {
      positions: { 'campus-cloud': ['300', '40'] },
      routes: [
        { from: 'web@browser', to: 'registration-api@api-pod', relation: 'derived', points: [['1', '2'], ['3', '4']] },
        { from: 'registration-api@api-pod', to: 'db@postgres', relation: 'derived', points: [['5', '6'], ['7', '8']] },
        { from: 'ingress', to: 'api-pod', relation: 'link', points: [['9', '9'], ['9', '10']] },
      ],
    },
    'dynamic enroll': { lifelines: ['web', 'registration-api', 'coordinator'] },
  });
});

test('deleting an element removes its positions, every route with an end at it, and its lifelines items', () => {
  const text = withLayout(REFERENCE,
    'deployment production:',
    '  routes:',
    '    - {from: web@browser, to: api@api-pod, relation: derived, points: [[1, 2], [3, 4]]}',
    '    - {from: ingress, to: api-pod, relation: link, points: [[9, 9], [9, 10]]}',
    'dynamic enroll:',
    '  lifelines: [web, seats, coordinator]',
    'code of policy:',
    '  positions: {EnrollmentPolicy: [80, 40], UnitCapRule: [540, 300]}');
  const deleted = applied(text, { op: 'deleteElement', elementId: 'web' }).text;
  assert.deepEqual(layoutOf(deleted, 'deployment production').routes, [route('ingress', 'api-pod', 'link', [[9, 9], [9, 10]])]);
  assert.deepEqual(layoutOf(deleted, 'dynamic enroll').lifelines, ['seats', 'coordinator']);
  assert.deepEqual(layoutOf(applied(deleted, { op: 'deleteElement', elementId: 'UnitCapRule' }).text, 'code of policy').positions,
    [['EnrollmentPolicy', [80, 40]]]);
});

test('a layout part or entry that a delete leaves empty goes too', () => {
  const text = withLayout(REFERENCE,
    'containers of registration: {web: [40, 120], api: [300, 120]}',
    'dynamic enroll:',
    '  lifelines: [web]',
    'code of policy:',
    '  positions: {UnitCapRule: [540, 300]}',
    '  routes:',
    '    - {from: EnrollmentPolicy, to: EnrollmentRule, relation: collaborator, points: [[380, 90], [420, 90]]}');
  const withoutRule = applied(text, { op: 'deleteElement', elementId: 'UnitCapRule' }).text;
  assert.deepEqual(Object.keys(dataAt(withoutRule, ['layout', 'code of policy'])), ['routes'], 'the emptied positions go');
  const withoutWeb = applied(withoutRule, { op: 'deleteElement', elementId: 'web' }).text;
  assert.deepEqual(Object.keys(dataAt(withoutWeb, ['layout'])), ['containers of registration', 'code of policy'],
    'the emptied lifeline order goes with its entry, and the C4 pins stay');
  assert.deepEqual(layoutDiagnostics(withoutWeb), []);
});

test('after deleting the pinned UnitCapRule and adding a code element named "Unit Cap Rule", code of policy has no position or route for UnitCapRule', () => {
  const collaborating = replaced(REFERENCE, '                implements: [EnrollmentRule]\n                operations: ["+ evaluate(student, section): RuleResult"]\n                choices: {patterns: [{pattern: Strategy, role: ConcreteStrategy, instance: eligibility-rules}]}\n          seats:',
    '                implements: [EnrollmentRule]\n                operations: ["+ evaluate(student, section): RuleResult"]\n                collaborators: {EnrollmentPolicy: reports a refusal to}\n                choices: {patterns: [{pattern: Strategy, role: ConcreteStrategy, instance: eligibility-rules}]}\n          seats:');
  const pinned = applied(collaborating, { op: 'setUmlLayout', viewKey: 'code of policy',
    positions: { EnrollmentPolicy: [80, 40], UnitCapRule: [540, 300] },
    routes: [route('UnitCapRule', 'EnrollmentPolicy', 'collaborator', [[540, 300], [80, 100]]), CODE_LAYOUT.routes[0]] }).text;
  const deleted = applied(pinned, { op: 'deleteElement', elementId: 'UnitCapRule' }).text;
  const added = applied(deleted, { op: 'addElement', parentId: 'policy', type: 'code', kind: 'class', name: 'Unit Cap Rule' });
  assert.deepEqual(added.selection, { elementId: 'UnitCapRule' }, 'the new element takes the old id');
  assert.deepEqual(layoutOf(added.text, 'code of policy'), { positions: [['EnrollmentPolicy', [80, 40]]], routes: [CODE_LAYOUT.routes[0]], lifelines: [] });
  assert.equal(layoutBlock(umlOf(added.text, 'code of policy').text).some((line) => line.includes('"UnitCapRule"')), false);
});

test('after deleting a pinned node "New node" with a bent link and adding a node named "New node" again, the view has no position and no route for new-node', () => {
  const linked = replaced(REFERENCE, '      data-centre:\n',
    '      new-node:\n        name: New node\n        collaborators:\n          campus-cloud: sends jobs to\n      data-centre:\n');
  const pinned = applied(linked, { op: 'setUmlLayout', viewKey: 'deployment production',
    positions: { laptop: [40, 40], 'new-node': [600, 40] },
    routes: [route('new-node', 'campus-cloud', 'link', [[600, 80], [400, 80]]), route('ingress', 'api-pod', 'link', [[520, 150], [520, 220]])] }).text;
  const removed = applied(pinned, { op: 'removeNode', environmentId: 'production', nodeId: 'new-node' }).text;
  const added = applied(removed, { op: 'addNode', environmentId: 'production', name: 'New node' });
  assert.deepEqual(added.selection, { environmentId: 'production', nodeId: 'new-node' }, 'the new node takes the old id');
  assert.deepEqual(layoutOf(added.text, 'deployment production'), {
    positions: [['laptop', [40, 40]]], routes: [route('ingress', 'api-pod', 'link', [[520, 150], [520, 220]])], lifelines: [],
  });
});

test('removeNode removes the routes that end at an instance on a node inside it, and a positions part it empties', () => {
  const pinned = applied(REFERENCE, { op: 'setUmlLayout', viewKey: 'deployment production',
    positions: { laptop: [40, 40] },
    routes: [route('web@browser', 'api@api-pod', 'derived', [[1, 2], [3, 4]]), route('ingress', 'api-pod', 'link', [[9, 9], [9, 10]])] }).text;
  const removed = applied(pinned, { op: 'removeNode', environmentId: 'production', nodeId: 'laptop' }).text;
  assert.deepEqual(dataAt(removed, ['layout', 'deployment production']), {
    routes: [{ from: 'ingress', to: 'api-pod', relation: 'link', points: [['9', '9'], ['9', '10']] }],
  });
});

test('after un-hosting api from api-pod and hosting it there again, its derived path has no stored bend', () => {
  const pinned = applied(REFERENCE, { op: 'setUmlLayout', viewKey: 'deployment production',
    routes: [route('web@browser', 'api@api-pod', 'derived', [[100, 300], [400, 300]]), route('ingress', 'api-pod', 'link', [[520, 150], [520, 220]])] }).text;
  const unhosted = applied(pinned, { op: 'setHosts', environmentId: 'production', nodeId: 'api-pod', hosts: [] }).text;
  const hosted = applied(unhosted, { op: 'setHosts', environmentId: 'production', nodeId: 'api-pod', hosts: ['api'] }).text;
  assert.deepEqual(layoutOf(hosted, 'deployment production').routes, [route('ingress', 'api-pod', 'link', [[520, 150], [520, 220]])]);
  const uml = umlOf(hosted, 'deployment production');
  const derived = lineOf(uml, (entry) => entry.kind === 'link' && entry.from === 'web@browser');
  assert.equal(layoutBlock(uml.text).some((line) => line.startsWith(`edge "rel:${derived}"`)), false, 'the path is drawn again, without a bend');
});

// ---- The JSON Schema (spec §4.2) ---------------------------------------------------------------------------------------

/** A validator for the draft-07 subset the generated schema uses; no validator library is available. */
function validator(rootSchema) {
  const resolve = (ref) => ref.slice('#/definitions/'.length).split('/').reduce((node, key) => node[key], rootSchema.definitions);
  const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array'
    : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value);
  const typeMatches = (expected, value) => [].concat(expected)
    .some((name) => name === typeOf(value) || (name === 'number' && typeOf(value) === 'integer'));
  const objectValid = (node, value) => {
    const declared = node.properties || {};
    const patterns = Object.entries(node.patternProperties || {});
    if (!(node.required || []).every((key) => key in value)) return false;
    return Object.entries(value).every(([key, item]) => {
      const matching = patterns.filter(([pattern]) => new RegExp(pattern).test(key));
      if (key in declared && !valid(declared[key], item)) return false;
      if (!matching.every(([, subschema]) => valid(subschema, item))) return false;
      return key in declared || matching.length > 0 || node.additionalProperties !== false;
    });
  };
  function valid(node, value) {
    if (node.$ref) return valid(resolve(node.$ref), value);
    if (node.anyOf && !node.anyOf.some((option) => valid(option, value))) return false;
    if (node.enum && !node.enum.some((option) => option === value)) return false;
    if (node.if) {
      const branch = valid(node.if, value) ? node.then : node.else;
      if (branch && !valid(branch, value)) return false;
    }
    if (node.type && !typeMatches(node.type, value)) return false;
    if (node.pattern && !(typeof value === 'string' && new RegExp(node.pattern).test(value))) return false;
    if (node.minimum !== undefined && !(typeof value === 'number' && value >= node.minimum)) return false;
    if (typeOf(value) === 'array') {
      if (node.minItems !== undefined && value.length < node.minItems) return false;
      if (node.maxItems !== undefined && value.length > node.maxItems) return false;
      if (node.items && !value.every((item) => valid(node.items, item))) return false;
    }
    return typeOf(value) !== 'object' || objectValid(node, value);
  }
  return (value) => valid(rootSchema, value);
}

const ROUTE = '{from: EnrollmentPolicy, to: EnrollmentRule, relation: collaborator, points: [[380, 90], [420, 90]]}';

// The JSON Schema cannot follow a custom view's id to the view it is based on, so under a custom view's key it accepts a
// pin map and the parts of any UML view, which the model tells apart; the corpus holds custom view keys where both agree.
const LAYOUT_CORPUS = {
  accepted: {
    'positions and routes under a code view key': withLayout(REFERENCE, 'code of policy:', '  positions: {EnrollmentPolicy: [80, 40.5]}', '  routes:', `    - ${ROUTE}`),
    'positions and routes of links and derived paths under a deployment view key': withLayout(REFERENCE, ...DEPLOYMENT_ENTRY),
    'positions under an interfaces view key': withLayout(INTERFACES, 'interfaces of api:', '  positions: {web: [60, 40], api: [60, 260]}'),
    'lifelines under a dynamic view key': withLayout(REFERENCE, 'dynamic enroll:', '  lifelines: [web, policy]'),
    'an annotated view key in another letter case': withLayout(REFERENCE, 'Code of policy with Patterns:', '  positions: {EnrollmentPolicy: [80, 40]}'),
    'extension keys beside the parts and in a route': withLayout(REFERENCE, 'code of policy:', '  x-note: moved by hand', '  routes:',
      '    - {from: EnrollmentPolicy, to: EnrollmentRule, relation: collaborator, points: [[380, 90], [420, 90]], x-why: clear of the rules}'),
    'the parts of a custom view based on a code view': withLayout(`${REFERENCE.replace(/\n*$/, '\n')}views:\n  rules:\n    view: code of policy\n`,
      'rules:', '  positions: {EnrollmentRule: [420, 40]}', '  routes:', `    - ${ROUTE}`),
    'a pin map under a custom view based on a C4 view': withLayout(`${REFERENCE.replace(/\n*$/, '\n')}views:\n  apps:\n    view: containers of registration\n`,
      'apps:', '  web: [40, 120]'),
    'a pin map under a C4 view key': withLayout(REFERENCE, 'containers of registration:', '  web: [40, 120]', 'landscape:', '  registration: [0, 0]'),
  },
  rejected: {
    'a pin map under a code view key': withLayout(REFERENCE, 'code of policy:', '  EnrollmentPolicy: [80, 40]'),
    'lifelines under a code view key': withLayout(REFERENCE, 'code of policy:', '  lifelines: [EnrollmentPolicy]'),
    'routes under an interfaces view key': withLayout(INTERFACES, 'interfaces of api:', '  routes:', `    - ${ROUTE}`),
    'positions under a dynamic view key': withLayout(REFERENCE, 'dynamic enroll:', '  positions: {web: [1, 2]}'),
    'a route with one point': withLayout(REFERENCE, 'code of policy:', '  routes:',
      '    - {from: EnrollmentPolicy, to: EnrollmentRule, relation: collaborator, points: [[380, 90]]}'),
    'a route without a relation': withLayout(REFERENCE, 'code of policy:', '  routes:',
      '    - {from: EnrollmentPolicy, to: EnrollmentRule, points: [[380, 90], [420, 90]]}'),
    'a derived path under a code view key': withLayout(REFERENCE, 'code of policy:', '  routes:',
      '    - {from: EnrollmentPolicy, to: EnrollmentRule, relation: derived, points: [[380, 90], [420, 90]]}'),
    'a route of a realization': withLayout(REFERENCE, 'code of policy:', '  routes:',
      '    - {from: PrerequisiteRule, to: EnrollmentRule, relation: implements, points: [[380, 90], [420, 90]]}'),
    'a route with an unknown key': withLayout(REFERENCE, 'deployment production:', '  routes:',
      '    - {from: ingress, to: api-pod, relation: link, points: [[1, 2], [3, 4]], bend: true}'),
    'a position of three numbers': withLayout(REFERENCE, 'deployment production:', '  positions: {laptop: [1, 2, 3]}'),
  },
};

test('the JSON Schema agrees on the shared corpus', () => {
  const schemaAccepts = validator(core.toJsonSchema());
  const modelAccepts = (text) => !load(text).diagnostics.some((found) => found.severity === 'error');
  const verdicts = (corpus) => Object.entries(corpus).map(([name, text]) => [name, modelAccepts(text), schemaAccepts(YAML.parse(text))]);
  assert.deepEqual(verdicts(LAYOUT_CORPUS.accepted), Object.keys(LAYOUT_CORPUS.accepted).map((name) => [name, true, true]));
  assert.deepEqual(verdicts(LAYOUT_CORPUS.rejected), Object.keys(LAYOUT_CORPUS.rejected).map((name) => [name, false, false]));
});
