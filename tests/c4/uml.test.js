'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const p = require('../../c4/c4-projection.js');
const { toUml, escapeLabel } = require('../../c4/c4-uml.js');
const { fixture } = require('./helpers.js');

const REFERENCE = fixture('course-registration.yml');

// The ArchUML renderers, loaded as the browser loads them (before the document is ready).
const sandbox = { document: { readyState: 'loading', addEventListener() {}, documentElement: {} }, MutationObserver: class { observe() {} } };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../uml-bundle.js'), 'utf8'), sandbox);

/** Parser results are built in the sandbox's realm; a JSON round trip makes them comparable with local values. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(text) {
  return modelApi.normalize(y.parse(text), { source: 'embed' }).model;
}

const reference = load(REFERENCE);

function umlOf(model, selector) {
  return toUml(p.projectView(model, selector));
}

test('class text parses with the ArchUML class renderer', () => {
  const { type, text } = umlOf(reference, 'code of policy');
  assert.equal(type, 'class');
  const diagram = plain(sandbox.UMLClassDiagram.parse(text));
  assert.deepEqual(diagram.classes.map((entry) => [entry.name, entry.type]),
    [['EnrollmentPolicy', 'class'], ['EnrollmentRule', 'interface'], ['PrerequisiteRule', 'class'], ['UnitCapRule', 'class']]);
  assert.ok(text.includes('PrerequisiteRule ..|> EnrollmentRule'));
  assert.ok(text.includes('EnrollmentPolicy ..> EnrollmentRule : asks each rule to evaluate the student with'));
});

test('lifted elements become stereotyped classes named by identifier-safe display names', () => {
  const withLift = REFERENCE.replace('            code:\n', [
    '            code:',
    '              audit:',
    '                kind: function',
    '                collaborators:',
    '                  billing: reports the charge to',
    '                  student: notifies',
  ].join('\n') + '\n');
  assert.notEqual(withLift, REFERENCE);
  const { text } = umlOf(load(withLift), 'code of policy');
  const classes = plain(sandbox.UMLClassDiagram.parse(text)).classes;
  assert.deepEqual(classes.filter((entry) => entry.stereotype).map((entry) => [entry.name, entry.stereotype]),
    [['audit', 'function'], ['Billing_System', 'software system'], ['Student', 'person']]);
  assert.ok(text.includes('audit ..> Billing_System : reports the charge to'));
});

test('sequence text parses with the ArchUML sequence renderer', () => {
  const { type, text } = umlOf(reference, 'dynamic enroll');
  assert.equal(type, 'sequence');
  const diagram = plain(sandbox.UMLSequenceDiagram.parse(text));
  assert.deepEqual(diagram.participants.map((participant) => participant.id),
    ['web', 'coordinator', 'policy', 'seats', 'billing_gateway']);
  assert.deepEqual(diagram.messages.filter((entry) => entry.type.startsWith('fragment')).map((entry) => [entry.type, entry.fragType || null, entry.condition || null]),
    [['fragment_start', 'alt', 'eligible'], ['fragment_else', null, 'not eligible'], ['fragment_end', null, null]]);
  assert.equal(diagram.messages.filter((entry) => entry.msgType === 'response').length, 1);
  assert.ok(text.includes('box "Registration API"'));
});

test('deployment text nests nodes and stereotypes instances', () => {
  const { type, text } = umlOf(reference, 'deployment production');
  assert.equal(type, 'deployment');
  assert.ok(text.includes('node "API pod ×3" as api_pod <<executionEnvironment>>'));
  assert.ok(text.includes('component "Registration API" as api <<container>>'));
  assert.ok(text.includes('  node "Web browser" as browser <<executionEnvironment>> {\n    component "Planner Web App" as web <<container>>'));
  assert.ok(text.includes('api --> billing dashed : requests tuition charges from [AMQP]'));
  assert.ok(text.includes('ingress --> api_pod : forwards HTTPS requests to'));
});

test('identifiers that collide after sanitizing get numbered suffixes', () => {
  const view = {
    key: 'deployment probe', notation: 'uml-deployment',
    uml: {
      nodes: [
        { id: 'a-b', name: 'First', kind: null, instances: 1, parentId: null, hosted: [] },
        { id: 'a_b', name: 'Second', kind: null, instances: 1, parentId: null, hosted: [] },
      ],
      links: [{ sourceId: 'a-b', targetId: 'a_b', label: 'calls', technology: null, async: false }],
    },
  };
  assert.equal(toUml(view).text, '@startuml\nnode "First" as a_b\nnode "Second" as a_b_2\na_b --> a_b_2 : calls\n@enduml');
});

test('generated labels cannot inject statements', () => {
  const hostile = REFERENCE.replace('- web -> coordinator: submits the plan to', '- web -> coordinator: "a --> b }\\n@enduml"');
  assert.notEqual(hostile, REFERENCE);
  const { text } = umlOf(load(hostile), 'dynamic enroll');
  assert.deepEqual(text.split('\n').filter((line) => line.startsWith('@')), ['@startuml', '@enduml']);
  assert.equal(text.split('\n').length, umlOf(reference, 'dynamic enroll').text.split('\n').length,
    'the hostile description stays on its one message line');
  const diagram = plain(sandbox.UMLSequenceDiagram.parse(text));
  const first = diagram.messages.find((entry) => entry.type === 'message');
  assert.equal(diagram.messages.filter((entry) => entry.type === 'message').length, 5);
  assert.match(first.label, /a/);
  assert.match(first.label, /b/);
  assert.equal([first.from, first.to].join('>'), 'web>coordinator');
});

test('escapeLabel turns newlines into spaces and defuses quotes, arrows, braces, and directives', () => {
  const escaped = escapeLabel('say "hi"\nthen {a} -> b --> c ..> d <-- e @enduml @pos(1, 2)');
  assert.doesNotMatch(escaped, /["\r\n{}]|->|-->|\.\.>|<--|@enduml|@pos/);
  assert.equal(escaped.replace(/​/g, ''), 'say ”hi” then ｛a｝ -> b --> c ..> d <-- e @enduml @pos(1, 2)');
  assert.equal(escapeLabel('plain text, 100%'), 'plain text, 100%');
});

test('a C4-notation view has no ArchUML text', () => {
  assert.throws(() => toUml(p.projectView(reference, 'containers of registration')), /no ArchUML text/);
});
