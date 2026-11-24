'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const checks = require('../../c4/c4-checks.js');
const { fixture } = require('./helpers.js');

// The RDD, cross-level, and design-choice rules of spec §7.2.

/** Parses a design, requiring it to be a valid model, so every test fixture is free of schema diagnostics. */
function load(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : lines;
  const parsed = y.parse(text);
  const { model, diagnostics } = modelApi.normalize(parsed, { source: 'embed' });
  assert.deepEqual(diagnostics, [], 'fixture diagnostics');
  return { text, parsed, model };
}

/** The diagnostics of one rule that the semantic rules report for a design. */
function reported(lines, ruleId, options = {}) {
  const { text, parsed, model } = load(lines);
  const diagnostics = checks.run(model, Object.assign({ parsed }, options)).filter((diagnostic) => diagnostic.rule === ruleId);
  return { text, diagnostics };
}

/** 1-based number of the first line containing `needle`, searching from the first line containing `after`. */
function lineOf(text, needle, after = null) {
  const lines = text.split('\n');
  const start = after === null ? 0 : lines.findIndex((line) => line.includes(after));
  assert.notEqual(start, -1, `${after} is in the fixture`);
  const index = lines.findIndex((line, at) => at >= start && line.includes(needle));
  assert.notEqual(index, -1, `${needle} is in the fixture`);
  return index + 1;
}

const byLine = (a, b) => a.line - b.line || String(a.element).localeCompare(String(b.element));

/** Asserts the element, severity, and line of every diagnostic one rule reports; returns the diagnostics. */
function expectFindings(lines, ruleId, expected, options = {}) {
  const { text, diagnostics } = reported(lines, ruleId, options);
  const seen = diagnostics.map((diagnostic) => ({
    element: diagnostic.element, severity: diagnostic.severity, line: diagnostic.range && diagnostic.range.start.line,
  }));
  const wanted = expected.map(({ element, severity, needle, after = null }) => ({ element, severity, line: lineOf(text, needle, after) }));
  assert.deepEqual(seen.sort(byLine), wanted.sort(byLine));
  return diagnostics;
}

function expectNone(lines, ruleId, options = {}) {
  assert.deepEqual(reported(lines, ruleId, options).diagnostics, []);
}

/** A system `planner` with the given container lines (indented 6 spaces); `after` lines follow at their own indentation. */
function plannerWith(containerLines, { systemLines = [], before = [], after = [] } = {}) {
  return [
    ...before,
    'systems:',
    '  planner:',
    '    name: Planner',
    '    description: Plans term schedules for students.',
    ...systemLines,
    '    containers:',
    ...containerLines,
    ...after,
  ];
}

/** The container `api` with the given lines (indented 8 spaces) and component lines (indented 10 spaces). */
function apiWith(componentLines, apiLines = []) {
  return [
    '      api:',
    '        name: Planner API',
    '        technology: Python',
    '        description: Serves term plans to students.',
    ...apiLines,
    ...(componentLines.length > 0 ? ['        components:', ...componentLines] : []),
  ];
}

const pad = (indent, lines) => lines.map((line) => ' '.repeat(indent) + line);

/** An external system `billing`, as lines of the `systems:` map. */
const BILLING = ['  billing:', '    name: Billing System', '    external: true', '    description: Charges tuition for the university.'];

// ---- Catalog and reference model -------------------------------------------------------------

test('the catalog lists each RDD, cross-level, and choices rule with the severity of spec 7.2', () => {
  const severities = {
    'rdd/no-responsibility': 'warning', 'rdd/untyped': 'warning', 'rdd/not-an-obligation': 'warning', 'rdd/vague': 'info',
    'rdd/owner-named': 'info', 'rdd/no-reason': 'warning', 'rdd/duplicate-authority': 'warning', 'rdd/duplicate-decision': 'info',
    'rdd/god-element': 'warning', 'rdd/manager-name': 'info', 'rdd/centralized-control': 'info', 'rdd/coordinator-decides': 'info',
    'rdd/stereotype-mismatch': 'info', 'rdd/boundary-without-interfacer': 'info', 'rdd/unrefined': 'info',
    'rdd/collaboration-cycle': 'info', 'rdd/unmeasurable-quality': 'info', 'rdd/uncovered-requirement': 'info',
    'choices/unknown-pattern': 'info', 'choices/unknown-style': 'info', 'choices/unknown-role': 'warning',
    'choices/incomplete-pattern': 'warning',
    'xlevel/scenario-step': 'error', 'xlevel/scenario-levels': 'warning', 'xlevel/unreceived': 'info', 'xlevel/unsent': 'info',
    'xlevel/unsummarized': 'info', 'xlevel/summary-copy': 'info', 'xlevel/undeployed': 'info',
  };
  const catalog = new Map(checks.RULES.map((entry) => [entry.id, entry]));
  Object.entries(severities).forEach(([id, severity]) => {
    assert.ok(catalog.has(id), `${id} is in the catalog`);
    assert.equal(catalog.get(id).severity, severity, id);
    assert.equal(catalog.get(id).category, id.slice(0, id.indexOf('/')), id);
    assert.ok(catalog.get(id).title && catalog.get(id).rationale && catalog.get(id).source, `${id} has help text and a source`);
  });
  assert.equal(new Set(checks.RULES.map((entry) => entry.id)).size, checks.RULES.length, 'rule ids are unique');
});

test('the reference model has zero errors and zero warnings under default options', () => {
  const { parsed, model } = load(fixture('course-registration.yml'));
  const diagnostics = checks.applyConfig(checks.run(model, { parsed }), model, { parsed });
  assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.severity !== 'info'), []);
});

// ---- Responsibilities ------------------------------------------------------------------------

test('rdd/no-responsibility warns on internal systems, containers, and components, and informs on code and external systems', () => {
  const lines = plannerWith(apiWith([
    '          kernel:',
    '            name: Kernel',
    '            technology: Python module',
    '            description: Runs the scheduling algorithm.',
    '            code:',
    '              Plain: {kind: class}',
  ], ['        responsibilities: [do: serve term plans]']), {
    before: ['people:', '  student:', '    name: Student', '    description: Plans one term schedule.'],
    after: BILLING,
  });
  expectFindings(lines, 'rdd/no-responsibility', [
    { element: 'planner', severity: 'warning', needle: '  planner:' },
    { element: 'kernel', severity: 'warning', needle: 'kernel:' },
    { element: 'Plain', severity: 'info', needle: 'Plain:' },
    { element: 'billing', severity: 'info', needle: '  billing:' },
  ]);
});

test('rdd/untyped flags a responsibility without KNOW, DO, or DECIDE', () => {
  const lines = plannerWith(apiWith([], ['        responsibilities: [do: serve term plans]']), {
    systemLines: ['    responsibilities:', '      - plan term schedules for students', '      - do: enroll students in sections'],
  });
  expectFindings(lines, 'rdd/untyped', [{ element: 'planner', severity: 'warning', needle: '- plan term schedules' }]);
});

test('rdd/not-an-obligation flags calls, identifiers, UI steps, and HTTP requests, and accepts an obligation', () => {
  const lines = plannerWith(apiWith([], [
    '        responsibilities:',
    '          - do: getSeats()',
    '          - know: openSeats(section)',
    '          - do: click Submit',
    '          - do: POST /enroll',
    '          - know: seatCount',
    '          - know: which seats are open in each section',
  ]));
  expectFindings(lines, 'rdd/not-an-obligation', ['getSeats()', 'openSeats(section)', 'click Submit', 'POST /enroll', 'seatCount']
    .map((needle) => ({ element: 'api', severity: 'warning', needle })));
});

test('rdd/not-an-obligation accepts a lone plain word, as a sketch writes it', () => {
  const lines = plannerWith(apiWith([], ['        responsibilities:', '          - know: prerequisites', '          - do: enroll']));
  expectNone(lines, 'rdd/not-an-obligation');
});

test('rdd/not-an-obligation flags a lone word only when it is code-shaped', () => {
  const lines = plannerWith(apiWith([], ['        responsibilities:', '          - know: seat_count', '          - know: plan.term',
    '          - know: section2', '          - know: SeatCount']));
  expectFindings(lines, 'rdd/not-an-obligation', ['seat_count', 'plan.term', 'section2', 'SeatCount']
    .map((needle) => ({ element: 'api', severity: 'warning', needle })));
});

test('rdd/not-an-obligation flags getters and setters written as words', () => {
  const lines = plannerWith(apiWith([], ['        responsibilities:', '          - do: get the seat count', '          - do: set up enrollment windows']));
  expectFindings(lines, 'rdd/not-an-obligation', [{ element: 'api', severity: 'warning', needle: 'get the seat count' }]);
});

test('rdd/vague flags handle, manage, process, or support with at most one noun', () => {
  const lines = plannerWith(apiWith([], [
    '        responsibilities:',
    '          - do: handle registration',
    '          - do: manage the seats',
    '          - do: process enrollment requests',
  ]));
  expectFindings(lines, 'rdd/vague', [
    { element: 'api', severity: 'info', needle: 'handle registration' },
    { element: 'api', severity: 'info', needle: 'manage the seats' },
  ]);
});

test('rdd/owner-named flags a responsibility whose subject is another element, not the owner itself', () => {
  const lines = plannerWith([
    ...apiWith([], [
      '        responsibilities:',
      '          - do: Seat Gateway holds every requested seat',
      '          - do: Planner API answers plan requests',
      '          - do: hold every requested seat',
    ]),
    '      gateway:',
    '        name: Seat Gateway',
    '        description: Holds seats in the campus seat system.',
  ]);
  expectFindings(lines, 'rdd/owner-named', [{ element: 'api', severity: 'info', needle: 'Seat Gateway holds' }]);
});

// ---- Collaborations and authority ------------------------------------------------------------

test('rdd/no-reason flags a collaborator map without a description', () => {
  const lines = plannerWith([
    ...apiWith([], ['        collaborators:', '          db: {technology: SQL/TCP}', '          cache: reads term plans from']),
    '      db: {name: Plan Store, kind: database}',
    '      cache: {name: Plan Cache, kind: database}',
  ]);
  expectFindings(lines, 'rdd/no-reason', [{ element: 'api', severity: 'warning', needle: 'db: {technology' }]);
});

test('rdd/duplicate-authority warns when an element off the owner chain owns the same fact', () => {
  const lines = plannerWith([
    ...apiWith([], ['        owns: [seat holds]']),
    '      worker:',
    '        name: Hold Sweeper',
    '        owns: [Seat  Holds]',
  ], { systemLines: ['    owns: [seat holds]'] });
  expectFindings(lines, 'rdd/duplicate-authority', [{ element: 'worker', severity: 'warning', needle: 'owns:', after: 'worker:' }]);
});

test('rdd/duplicate-authority informs when an off-chain element KNOWs a fact another element owns', () => {
  const lines = plannerWith([
    ...apiWith([], ['        owns: [seat holds]']),
    '      reporter:',
    '        name: Hold Reporter',
    '        responsibilities: [know: the seat holds of every section]',
  ]);
  expectFindings(lines, 'rdd/duplicate-authority', [{ element: 'reporter', severity: 'info', needle: 'know: the seat holds' }]);
});

test('rdd/duplicate-authority exempts a data store the owner writes to', () => {
  const lines = plannerWith([
    ...apiWith([], ['        owns: [seat holds]', '        collaborators:', '          db: {description: writes seat holds to, technology: SQL}']),
    '      db:',
    '        name: Seat Store',
    '        kind: database',
    '        owns: [seat holds]',
    '        responsibilities: [know: seat holds]',
  ]);
  expectNone(lines, 'rdd/duplicate-authority');
});

test('rdd/duplicate-decision informs on a near-duplicate DECIDE off the same chain, and exempts the chain', () => {
  const lines = plannerWith([
    ...apiWith([], ['        responsibilities: [decide: whether a student may enroll in a section]']),
    '      worker:',
    '        name: Enrollment Checker',
    '        responsibilities: [decide: whether the student can enroll in this section]',
    '      rooms:',
    '        name: Room Planner',
    '        responsibilities: [decide: which room hosts each section]',
  ], { systemLines: ['    responsibilities: [decide: whether a student may enroll in a section]'] });
  expectFindings(lines, 'rdd/duplicate-decision', [{ element: 'worker', severity: 'info', needle: 'whether the student can enroll' }]);
});

// ---- Element size and names ------------------------------------------------------------------

/** An element `hub` with numbered responsibilities and collaborators to sibling `peer` elements, at `indent` spaces. */
function hubLines(indent, { responsibilities = 0, collaborators = 0 }) {
  const numbers = (count) => Array.from({ length: count }, (_, index) => index + 1);
  return pad(indent, [
    'hub:',
    '  name: Enrollment Hub',
    ...(responsibilities > 0 ? ['  responsibilities:', ...numbers(responsibilities).map((n) => `    - do: carry out enrollment duty ${n}`)] : []),
    ...(collaborators > 0 ? ['  collaborators:', ...numbers(collaborators).map((n) => `    peer${n}: asks for help number ${n} from`)] : []),
    ...numbers(collaborators).map((n) => `peer${n}: {name: Peer ${n}}`),
  ]);
}

const componentHub = (counts) => plannerWith(apiWith(hubLines(10, counts)));
const containerHub = (counts) => plannerWith(hubLines(6, counts));

test('rdd/god-element warns on a component with more than 9 unrefined responsibilities', () => {
  expectNone(componentHub({ responsibilities: 9 }), 'rdd/god-element');
  expectFindings(componentHub({ responsibilities: 10 }), 'rdd/god-element', [{ element: 'hub', severity: 'warning', needle: 'hub:' }]);
});

test('rdd/god-element warns on a component with more than 7 collaborators', () => {
  expectNone(componentHub({ collaborators: 7 }), 'rdd/god-element');
  expectFindings(componentHub({ collaborators: 8 }), 'rdd/god-element', [{ element: 'hub', severity: 'warning', needle: 'hub:' }]);
});

test('rdd/god-element informs on a container and never reports a system', () => {
  expectFindings(containerHub({ responsibilities: 10 }), 'rdd/god-element', [{ element: 'hub', severity: 'info', needle: 'hub:' }]);
  const responsibilities = Array.from({ length: 12 }, (_, index) => `      - do: carry out planning duty ${index + 1}`);
  expectNone(plannerWith(apiWith([]), { systemLines: ['    responsibilities:', ...responsibilities] }), 'rdd/god-element');
});

test('rdd/god-element does not count responsibilities a descendant refines', () => {
  const lines = plannerWith(apiWith([
    ...hubLines(10, { responsibilities: 9 }),
    '              - do: carry out enrollment duty 10',
    '                id: hub-duty-10',
    '            code:',
    '              DutyTen:',
    '                responsibilities:',
    '                  - do: carry out one part of duty 10',
    '                    refines: hub-duty-10',
  ]));
  expectNone(lines, 'rdd/god-element');
});

test('rdd/god-element limits follow the configured thresholds', () => {
  expectFindings(componentHub({ responsibilities: 3 }), 'rdd/god-element', [{ element: 'hub', severity: 'warning', needle: 'hub:' }],
    { thresholds: { unrefinedResponsibilities: 2 } });
});

test('rdd/manager-name informs on a design element named like a manager, but not on a person', () => {
  const lines = plannerWith([
    ...apiWith([]),
    '      seats: {name: Seat Manager}',
    '      gateway: {name: Seat Gateway}',
    '      utils: {name: Date Util}',
  ], { before: ['people:', '  advisor: {name: Account Manager}'] });
  expectFindings(lines, 'rdd/manager-name', [
    { element: 'seats', severity: 'info', needle: 'seats: {name' },
    { element: 'utils', severity: 'info', needle: 'utils: {name' },
  ]);
});

// ---- Control style and stereotypes -----------------------------------------------------------

test('rdd/centralized-control informs when one of three siblings decides while the rest only KNOW', () => {
  const siblings = (otherKind) => plannerWith(apiWith([
    '          brain:',
    '            name: Enrollment Brain',
    '            responsibilities: [decide: whether a student may enroll, decide: which section to offer]',
    '          roster: {name: Roster, responsibilities: [know: the students of each section]}',
    `          catalog: {name: Catalog, responsibilities: [${otherKind}: the sections of each course]}`,
  ]));
  expectFindings(siblings('know'), 'rdd/centralized-control', [{ element: 'brain', severity: 'info', needle: 'brain:' }]);
  expectNone(siblings('do'), 'rdd/centralized-control');
});

test('rdd/centralized-control needs three or more siblings', () => {
  const lines = plannerWith(apiWith([
    '          brain: {name: Enrollment Brain, responsibilities: [decide: whether a student may enroll]}',
    '          roster: {name: Roster, responsibilities: [know: the students of each section]}',
  ]));
  expectNone(lines, 'rdd/centralized-control');
});

test('rdd/coordinator-decides asks about a coordinator decision and skips sequencing decisions', () => {
  const lines = plannerWith(apiWith([
    '          coordinator:',
    '            name: Registration Coordinator',
    '            stereotypes: [coordinator]',
    '            responsibilities:',
    '              - decide: whether a student may enroll',
    '              - decide: which step of the attempt runs next',
    '              - decide: in which sequence the seats are reserved',
  ]));
  expectFindings(lines, 'rdd/coordinator-decides', [{ element: 'coordinator', severity: 'info', needle: 'whether a student may enroll' }]);
});

test('rdd/stereotype-mismatch flags a controller without DECIDE, a holder without KNOW, and an interfacer inside its boundary', () => {
  const lines = plannerWith(apiWith([
    '          ctrl: {name: Enrollment Controller, stereotypes: [controller], responsibilities: [do: run an enrollment]}',
    '          judge: {name: Judge, stereotypes: [controller], responsibilities: [decide: whether a student may enroll]}',
    '          holder: {name: Plan Holder, stereotypes: [information_holder], responsibilities: [do: store plans]}',
    '          facts: {name: Plan Facts, stereotypes: [information_holder], responsibilities: [know: each draft plan]}',
    '          inner:',
    '            name: Inner Adapter',
    '            stereotypes: [interfacer]',
    '            collaborators: {judge: asks for an eligibility decision from}',
    '          outer:',
    '            name: Billing Adapter',
    '            stereotypes: [interfacer]',
    '            collaborators: {billing: requests tuition charges from}',
  ]), { after: BILLING });
  expectFindings(lines, 'rdd/stereotype-mismatch', [
    { element: 'ctrl', severity: 'info', needle: 'ctrl:' },
    { element: 'holder', severity: 'info', needle: 'holder:' },
    { element: 'inner', severity: 'info', needle: 'inner:' },
  ]);
});

test('rdd/boundary-without-interfacer informs on a component that calls an external system without the interfacer stereotype', () => {
  const lines = plannerWith(apiWith([
    '          charges:',
    '            name: Charges',
    '            collaborators: {billing: requests tuition charges from}',
    '          adapter:',
    '            name: Billing Adapter',
    '            stereotypes: [interfacer]',
    '            collaborators: {billing: requests refunds from}',
  ], ['        collaborators: {billing: sends nightly reports to}']), { after: BILLING });
  expectFindings(lines, 'rdd/boundary-without-interfacer', [{ element: 'charges', severity: 'info', needle: 'charges:' }]);
});

// ---- Refinement, cycles, qualities, requirements ---------------------------------------------

test('rdd/unrefined informs on a decomposed element responsibility that no descendant refines', () => {
  const lines = plannerWith(apiWith([
    '          kernel:',
    '            name: Kernel',
    '            responsibilities:',
    '              - do: compute one conflict-free schedule',
    '                refines: [sys-plan, api-serve]',
  ], ['        responsibilities:', '          - do: serve term plans', '            id: api-serve']), {
    systemLines: [
      '    responsibilities:',
      '      - do: plan conflict-free schedules',
      '        id: sys-plan',
      '      - do: publish the term calendar',
    ],
  });
  expectFindings(lines, 'rdd/unrefined', [{ element: 'planner', severity: 'info', needle: 'publish the term calendar' }]);
});

test('rdd/collaboration-cycle informs on a cycle among siblings, including one lifted from their children', () => {
  const lines = plannerWith([
    ...apiWith([], ['        collaborators: {worker: hands enrollment jobs to}']),
    '      worker:',
    '        name: Worker',
    '        components:',
    '          notifier: {name: Notifier, collaborators: {api: reports finished jobs to}}',
    '      db: {name: Plan Store, kind: database}',
  ]);
  const [diagnostic] = expectFindings(lines, 'rdd/collaboration-cycle', [{ element: 'api', severity: 'info', needle: '      api:' }]);
  assert.match(diagnostic.message, /api.*worker/);
});

test('rdd/collaboration-cycle is silent for a chain', () => {
  const lines = plannerWith([
    ...apiWith([], ['        collaborators: {worker: hands enrollment jobs to}']),
    '      worker: {name: Worker, collaborators: {db: writes job results to}}',
    '      db: {name: Plan Store, kind: database}',
  ]);
  expectNone(lines, 'rdd/collaboration-cycle');
});

test('rdd/unmeasurable-quality flags a quality without a number and unit or a comparator', () => {
  const lines = plannerWith(apiWith([], [
    '        quality:',
    '          - fast enough for students',
    '          - an outcome appears within 2 s for 95% of attempts',
    '          - faster than the paper process',
  ]));
  expectFindings(lines, 'rdd/unmeasurable-quality', [{ element: 'api', severity: 'info', needle: 'fast enough' }]);
});

test('rdd/uncovered-requirement informs on a requirement no responsibility references', () => {
  const lines = plannerWith(apiWith([]), {
    before: ['requirements:', '  FR-1: A student can plan a term.', '  FR-2: A student can drop a section.'],
    systemLines: ['    responsibilities:', '      - do: plan term schedules', '        requirements: [FR-1]'],
  });
  expectFindings(lines, 'rdd/uncovered-requirement', [{ element: null, severity: 'info', needle: 'FR-2:' }]);
});

// ---- Design choices --------------------------------------------------------------------------

test('choices/unknown-pattern and choices/unknown-style inform on names outside the catalog', () => {
  const lines = plannerWith(apiWith([], [
    '        choices:',
    '          styles: [layers, hexagonal]',
    '          patterns:',
    '            - "Strategy: Context"',
    '            - observer',
    '            - Repository',
    '        collaborators:',
    '          db: {description: stores plans in, technology: SQL, choices: {styles: [blackboard]}}',
  ]).concat(['      db: {name: Plan Store, kind: database}']));
  expectFindings(lines, 'choices/unknown-pattern', [{ element: 'api', severity: 'info', needle: '- Repository' }]);
  expectFindings(lines, 'choices/unknown-style', [
    { element: 'api', severity: 'info', needle: 'hexagonal' },
    { element: 'api', severity: 'info', needle: 'blackboard' },
  ]);
});

test('choices/unknown-role warns on a role the pattern does not define', () => {
  const lines = plannerWith(apiWith([], ['        choices:', '          patterns: ["Strategy: Driver", "Strategy: ConcreteStrategy"]']));
  expectFindings(lines, 'choices/unknown-role', [{ element: 'api', severity: 'warning', needle: 'patterns:' }]);
});

test('choices/incomplete-pattern warns on an instance missing a required role and exempts instance-less entries', () => {
  const lines = plannerWith(apiWith([
    '          rules:',
    '            name: Rules',
    '            choices: {patterns: [{pattern: Strategy, role: Context, instance: rule-set}, "Strategy: Context"]}',
    '          rule:',
    '            name: Rule',
    '            choices: {patterns: [{pattern: Strategy, role: Strategy, instance: rule-set}]}',
  ]));
  const [diagnostic] = expectFindings(lines, 'choices/incomplete-pattern', [{ element: 'rules', severity: 'warning', needle: 'instance: rule-set' }]);
  assert.match(diagnostic.message, /ConcreteStrategy/);
});

test('choices/incomplete-pattern is silent when an instance fills every required role', () => {
  expectNone(fixture('course-registration.yml'), 'choices/incomplete-pattern');
});

// ---- Scenarios -------------------------------------------------------------------------------

/** A planner whose `web` calls `api`, plus the given scenario steps (indented 6 spaces). */
function scenarioWith(stepLines) {
  return plannerWith([
    '      web: {name: Web App, collaborators: {api: {description: submits plans to, technology: JSON/HTTPS}}}',
    ...apiWith(['          kernel: {name: Kernel}']),
  ], {
    before: ['people:', '  student: {name: Student, collaborators: {web: plans a schedule using}}'],
    after: ['scenarios:', '  enroll:', '    title: Enroll', '    steps:', ...stepLines],
  });
}

test('xlevel/scenario-step is an error for a step with no backing relationship', () => {
  const lines = scenarioWith(['      - web -> api: submits the plan to', '      - api -> student: emails the outcome to']);
  expectFindings(lines, 'xlevel/scenario-step', [{ element: 'api', severity: 'error', needle: 'api -> student' }]);
});

test('xlevel/scenario-step accepts forward steps and replies', () => {
  expectNone(scenarioWith(['      - web -> api: submits the plan to', '      - api -> web: returns the outcome to']), 'xlevel/scenario-step');
});

test('xlevel/scenario-levels warns when a scenario contains an element and its ancestor', () => {
  const lines = scenarioWith(['      - web -> api: submits the plan to', '      - web -> kernel: asks for a schedule from']);
  expectFindings(lines, 'xlevel/scenario-levels', [{ element: 'kernel', severity: 'warning', needle: '  enroll:' }]);
});

// ---- Relationships across levels -------------------------------------------------------------

test('xlevel/unreceived and xlevel/unsent inform on relationships that land on a decomposed element', () => {
  const lines = plannerWith(apiWith([]), {
    before: ['people:', '  student: {name: Student, collaborators: {planner: plans a schedule using}}'],
    systemLines: ['    collaborators: {billing: requests tuition charges from}'],
    after: BILLING,
  });
  expectFindings(lines, 'xlevel/unreceived', [{ element: 'planner', severity: 'info', needle: 'planner: plans a schedule' }]);
  expectFindings(lines, 'xlevel/unsent', [{ element: 'planner', severity: 'info', needle: 'billing: requests tuition' }]);
});

test('xlevel/unreceived is silent when a child receives the same relationship', () => {
  const lines = plannerWith(apiWith([]), {
    before: ['people:', '  student: {name: Student, collaborators: {planner: plans a schedule using, api: submits plans to}}'],
  });
  expectNone(lines, 'xlevel/unreceived');
});

/** A planner whose containers `api` and `worker` both call the external billing system. */
function twoCallersOfBilling({ systemLines = [], workerDescription = 'requests refunds from' } = {}) {
  return plannerWith([
    ...apiWith([], ['        collaborators: {billing: requests tuition charges from}']),
    `      worker: {name: Worker, collaborators: {billing: ${workerDescription}}}`,
  ], { systemLines, after: BILLING });
}

test('xlevel/unsummarized informs when two lower-level relationships lift onto one pair without a summary', () => {
  expectFindings(twoCallersOfBilling(), 'xlevel/unsummarized', [{ element: 'planner', severity: 'info', needle: '  planner:' }]);
  expectNone(twoCallersOfBilling({ systemLines: ['    collaborators: {billing: exchanges charges and refunds with}'] }), 'xlevel/unsummarized');
});

test('xlevel/summary-copy informs on a summary copied verbatim from its only child relationship', () => {
  const lines = (summary) => plannerWith(apiWith([], ['        collaborators: {billing: requests tuition charges from}']), {
    systemLines: [`    collaborators: {billing: ${summary}}`], after: BILLING,
  });
  expectFindings(lines('Requests  tuition charges from'), 'xlevel/summary-copy', [{ element: 'planner', severity: 'info', needle: 'collaborators: {billing: Requests' }]);
  expectNone(lines('charges students through'), 'xlevel/summary-copy');
  expectNone(twoCallersOfBilling({ systemLines: ['    collaborators: {billing: requests tuition charges from}'] }), 'xlevel/summary-copy');
});

test('xlevel/undeployed informs on a container left out of an environment that hosts its siblings', () => {
  const lines = (hosts) => plannerWith([...apiWith([]), '      worker: {name: Worker}'], {
    after: ['deployment:', '  production:', '    nodes:', `      server: {name: Server, kind: environment, hosts: [${hosts}]}`],
  });
  expectFindings(lines('api'), 'xlevel/undeployed', [{ element: 'worker', severity: 'info', needle: 'worker: {name' }]);
  expectNone(lines('api, worker'), 'xlevel/undeployed');
});
