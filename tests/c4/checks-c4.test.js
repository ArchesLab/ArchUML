'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const checks = require('../../c4/c4-checks.js');
const { fixture } = require('./helpers.js');

/** Parses a design, requiring it to be a valid model, so every test fixture is free of schema diagnostics. */
function load(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : lines;
  const parsed = y.parse(text);
  const { model, diagnostics } = modelApi.normalize(parsed, { source: 'embed' });
  assert.deepEqual(diagnostics, [], 'fixture diagnostics');
  return { text, parsed, model };
}

/** The diagnostics of the C4 and view rules this file covers; checks-rdd.test.js covers the RDD and cross-level rules. */
function c4LayerRun(model, options) {
  return checks.run(model, options).filter((diagnostic) => ['c4', 'view'].includes(diagnostic.category));
}

/** The diagnostics of one rule that the semantic rules report for a design. */
function reported(lines, ruleId, options = {}) {
  const { text, parsed, model } = load(lines);
  const diagnostics = checks.run(model, Object.assign({ parsed }, options)).filter((diagnostic) => diagnostic.rule === ruleId);
  return { text, diagnostics };
}

/** 1-based number of the first line of `text` that contains `needle`. */
function lineOf(text, needle) {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `${needle} is in the fixture`);
  return index + 1;
}

/** What a reader of the Problems list sees about a diagnostic. */
function seen(text, diagnostics) {
  return diagnostics.map((diagnostic) => ({ element: diagnostic.element, severity: diagnostic.severity, line: diagnostic.range && diagnostic.range.start.line }))
    .sort((a, b) => String(a.element).localeCompare(String(b.element)));
}

function expectOne(lines, ruleId, { element, severity, needle }) {
  const { text, diagnostics } = reported(lines, ruleId);
  assert.deepEqual(seen(text, diagnostics), [{ element, severity, line: lineOf(text, needle) }]);
  return diagnostics[0];
}

function expectNone(lines, ruleId, options) {
  assert.deepEqual(reported(lines, ruleId, options).diagnostics, []);
}

/** A system with the given container YAML lines (already indented by 6 spaces). */
function systemWith(containerLines, { systemLines = [] } = {}) {
  return [
    'systems:',
    '  s:',
    '    name: Planner',
    '    description: Plans schedules for students.',
    ...systemLines,
    '    containers:',
    ...containerLines,
  ];
}

// ---- Catalog ---------------------------------------------------------------------------------

test('the catalog lists each rule of this layer with the severity of spec 7.2', () => {
  const severities = {
    'yaml/syntax': 'error', 'schema/unknown-key': 'error', 'model/containment-link': 'error', 'view/mixed-abstraction': 'error',
    'view/empty': 'warning', 'view/no-purpose': 'info',
    'c4/no-description': 'warning', 'c4/sparse-description': 'info', 'c4/no-technology': 'warning', 'c4/technology-tbd': 'info',
    'c4/vague-relationship': 'warning', 'c4/duplicate-relationship': 'warning', 'c4/cross-container-technology': 'warning',
    'c4/infrastructure-container': 'warning', 'c4/external-decomposed': 'warning', 'c4/duplicate-name': 'warning',
    'c4/isolated-element': 'warning', 'c4/generic-name': 'info', 'c4/large-view': 'warning', 'c4/broker-hub': 'info',
    'checks/unexplained-ignore': 'warning', 'checks/stale-ignore': 'info',
  };
  const catalog = new Map(checks.RULES.map((entry) => [entry.id, entry]));
  Object.entries(severities).forEach(([id, severity]) => {
    assert.ok(catalog.has(id), `${id} is in the catalog`);
    assert.equal(catalog.get(id).severity, severity, id);
    assert.equal(catalog.get(id).category, id.slice(0, id.indexOf('/')), id);
  });
  checks.RULES.forEach((entry) => {
    assert.ok(entry.title && entry.rationale && entry.source, `${entry.id} has help text and a source`);
  });
  assert.equal(new Set(checks.RULES.map((entry) => entry.id)).size, checks.RULES.length, 'rule ids are unique');
});

test('the reference model raises no diagnostic from the C4 and view rules', () => {
  const { parsed, model } = load(fixture('course-registration.yml'));
  assert.deepEqual(c4LayerRun(model, { parsed }), []);
});

test('diagnostics have the spec shape and no range without a parsed document', () => {
  const lines = ['people:', '  student:', '    name: Student'];
  const { model } = load(lines);
  const [diagnostic] = checks.run(model).filter((found) => found.rule === 'c4/no-description');
  assert.deepEqual(diagnostic, {
    rule: 'c4/no-description', severity: 'warning', category: 'c4',
    message: diagnostic.message, hint: diagnostic.hint, element: 'student', path: ['people', 'student'], range: null, fix: null,
  });
  assert.match(diagnostic.message, /Student/);
});

// ---- Descriptions ----------------------------------------------------------------------------

test('c4/no-description flags a box with neither description nor responsibilities, and exempts code elements', () => {
  const lines = [
    'people:',
    '  student:',
    '    name: Student',
    '  tutor:',
    '    name: Tutor',
    '    description: Teaches one student at a time.',
    ...systemWith([
      '      c:',
      '        name: Core',
      '        description: Hosts the scheduling kernel.',
      '        technology: Python',
      '        components:',
      '          k:',
      '            name: Kernel',
      '            technology: Python module',
      '            description: Runs the scheduling algorithm.',
      '            code:',
      '              Plain: {kind: class}',
    ], { systemLines: [] }),
    '  gate:',
    '    name: Enrollment Gate',
    '    responsibilities: [decide: who may enroll]',
  ];
  expectOne(lines, 'c4/no-description', { element: 'student', severity: 'warning', needle: 'student:' });
});

test('c4/no-description is silent when every box says what it is', () => {
  expectNone(['people:', '  student:', '    name: Student', '    description: Plans a term schedule.'], 'c4/no-description');
});

test('c4/sparse-description flags a description of three words and accepts four', () => {
  const lines = (description) => ['people:', '  student:', '    name: Student', `    description: ${description}`];
  expectOne(lines('Plans a schedule'), 'c4/sparse-description', { element: 'student', severity: 'info', needle: 'description: Plans a schedule' });
  expectNone(lines('Plans one term schedule'), 'c4/sparse-description');
});

// ---- Technology ------------------------------------------------------------------------------

const TECHNOLOGY_FIXTURE = (containerLines) => systemWith(containerLines);

test('c4/no-technology warns for a container without technology', () => {
  const lines = TECHNOLOGY_FIXTURE(['      web:', '        name: Web App', '        description: Shows schedules in the browser.']);
  expectOne(lines, 'c4/no-technology', { element: 'web', severity: 'warning', needle: 'web:' });
});

test('c4/no-technology warns for a component without technology', () => {
  const lines = TECHNOLOGY_FIXTURE([
    '      web:', '        name: Web App', '        technology: React', '        components:',
    '          form:', '            name: Plan Form', '            description: Collects the courses of a plan.']);
  expectOne(lines, 'c4/no-technology', { element: 'form', severity: 'warning', needle: 'form:' });
});

test('c4/no-technology is only information for a database or file store', () => {
  const lines = TECHNOLOGY_FIXTURE([
    '      db:', '        name: Plan Store', '        kind: database', '        description: Stores plans durably.',
    '      files:', '        name: Syllabus Files', '        kind: file_store', '        description: Holds uploaded syllabi.']);
  const { text, diagnostics } = reported(lines, 'c4/no-technology');
  assert.deepEqual(seen(text, diagnostics), [
    { element: 'db', severity: 'info', line: lineOf(text, 'db:') },
    { element: 'files', severity: 'info', line: lineOf(text, 'files:') },
  ]);
});

test('c4/no-technology is silent when the container names its technology', () => {
  expectNone(TECHNOLOGY_FIXTURE(['      web:', '        name: Web App', '        technology: React', '        description: Shows schedules in the browser.']), 'c4/no-technology');
});

test('a technology of TBD is c4/technology-tbd (info) instead of c4/no-technology', () => {
  const lines = TECHNOLOGY_FIXTURE(['      web:', '        name: Web App', '        technology: TBD', '        description: Shows schedules in the browser.']);
  expectOne(lines, 'c4/technology-tbd', { element: 'web', severity: 'info', needle: 'technology: TBD' });
  expectNone(lines, 'c4/no-technology');
});

test('c4/infrastructure-container flags a container whose technology is infrastructure', () => {
  const container = (technology) => TECHNOLOGY_FIXTURE(['      web:', '        name: Web App', `        technology: ${technology}`, '        description: Shows schedules in the browser.']);
  expectOne(container('Kubernetes'), 'c4/infrastructure-container', { element: 'web', severity: 'warning', needle: 'technology: Kubernetes' });
  expectOne(container('Java, JAR'), 'c4/infrastructure-container', { element: 'web', severity: 'warning', needle: 'technology: Java, JAR' });
  expectNone(container('Python, FastAPI'), 'c4/infrastructure-container');
});

// ---- Relationships ---------------------------------------------------------------------------

function relationshipFixture(collaboratorLines) {
  return systemWith([
    '      web:',
    '        name: Web App',
    '        technology: React',
    '        description: Shows schedules in the browser.',
    '        collaborators:',
    ...collaboratorLines,
    '      api:',
    '        name: Schedule API',
    '        technology: Python',
    '        description: Computes schedules for students.',
  ]);
}

test('c4/vague-relationship flags one- and two-word descriptions and accepts a phrase', () => {
  const lines = systemWith([
    '      web:', '        name: Web App', '        technology: React', '        description: Shows schedules in the browser.',
    '        collaborators:', '          api: uses',
    '          db: {description: section facts, technology: SQL}',
    '          mail: submits plans to',
    '      api:', '        name: Schedule API', '        technology: Python', '        description: Computes schedules for students.',
    '      db:', '        name: Store', '        technology: SQL', '        description: Stores schedules durably.',
    '      mail:', '        name: Mailer', '        technology: SMTP', '        description: Sends confirmation messages.',
  ]);
  const { text, diagnostics } = reported(lines, 'c4/vague-relationship');
  assert.deepEqual(diagnostics.map((diagnostic) => [diagnostic.element, diagnostic.range.start.line, diagnostic.severity]), [
    ['web', lineOf(text, 'api: uses'), 'warning'],
    ['web', lineOf(text, 'section facts'), 'warning'],
  ]);
});

test('c4/duplicate-relationship flags the second identical relationship between the same endpoints', () => {
  const lines = relationshipFixture(['          api:', '            - asks for schedules from', '            - asks for schedules from']);
  const { text, diagnostics } = reported(lines, 'c4/duplicate-relationship');
  assert.deepEqual(seen(text, diagnostics), [{ element: 'web', severity: 'warning', line: lineOf(text, 'asks for schedules from') + 1 }]);
});

test('c4/duplicate-relationship accepts two relationships with different descriptions', () => {
  expectNone(relationshipFixture(['          api:', '            - asks for schedules from', '            - reports usage to']), 'c4/duplicate-relationship');
});

const CROSS_CONTAINER = (technologySuffix) => [
  'people:',
  '  student:',
  '    name: Student',
  '    description: Plans one term schedule.',
  '    collaborators:',
  '      web: browses the planner using',
  'systems:',
  '  payments:',
  '    name: Payment System',
  '    external: true',
  '    description: Charges fees for the university.',
  '  s:',
  '    name: Planner',
  '    description: Plans schedules for students.',
  '    containers:',
  '      web:',
  '        name: Web App',
  '        technology: React',
  '        description: Shows schedules in the browser.',
  '        collaborators:',
  `          api: {description: asks for schedules from${technologySuffix}}`,
  '      api:',
  '        name: Schedule API',
  '        technology: Python',
  '        description: Computes schedules for students.',
  '        components:',
  '          calc:',
  '            name: Calculator',
  '            technology: Python module',
  '            description: Builds one conflict-free schedule.',
  '            collaborators:',
  `              payments: {description: charges fees through${technologySuffix}}`,
  '              rules: asks for the rules of a term from',
  '          rules:',
  '            name: Rule Book',
  '            technology: Python module',
  '            description: Knows the rules of each term.',
];

test('c4/cross-container-technology flags container-to-container and component-to-external-system links without technology', () => {
  const { text, diagnostics } = reported(CROSS_CONTAINER(''), 'c4/cross-container-technology');
  assert.deepEqual(diagnostics.map((diagnostic) => [diagnostic.element, diagnostic.range.start.line, diagnostic.severity]), [
    ['web', lineOf(text, 'api: {description'), 'warning'],
    ['calc', lineOf(text, 'payments: {description'), 'warning'],
  ]);
});

test('c4/cross-container-technology accepts links with technology, links inside one container, and links from people', () => {
  expectNone(CROSS_CONTAINER(', technology: JSON/HTTPS'), 'c4/cross-container-technology');
});

// ---- Structure and names ---------------------------------------------------------------------

test('c4/external-decomposed flags an external system that has containers', () => {
  const external = (isExternal) => [
    'systems:', '  mail:', '    name: Mail System', `    external: ${isExternal}`, '    description: Delivers email to students.',
    '    containers:', '      smtp:', '        name: SMTP Relay', '        technology: Postfix', '        description: Relays outgoing mail.',
  ];
  expectOne(external(true), 'c4/external-decomposed', { element: 'mail', severity: 'warning', needle: 'mail:' });
  expectNone(external(false), 'c4/external-decomposed');
});

test('c4/duplicate-name flags the later sibling, including a person and a system at the top level', () => {
  const lines = [
    'people:', '  student:', '    name: Student', '    description: Plans one term schedule.',
    'systems:', '  student-portal:', '    name: Student', '    description: Shows students their schedule.',
    '    containers:',
    '      web:', '        name: Web', '        technology: React', '        description: Shows schedules in the browser.',
    '      web-copy:', '        name: web', '        technology: React', '        description: Shows schedules in the browser.',
  ];
  const { text, diagnostics } = reported(lines, 'c4/duplicate-name');
  assert.deepEqual(seen(text, diagnostics), [
    { element: 'student-portal', severity: 'warning', line: lineOf(text, 'student-portal:') },
    { element: 'web-copy', severity: 'warning', line: lineOf(text, 'web-copy:') },
  ]);
});

test('c4/duplicate-name accepts the same name under different parents', () => {
  const lines = [
    'systems:',
    '  a:', '    name: A', '    description: First system of the pair.', '    containers:',
    '      web: {name: Web, technology: React, description: Shows pages in the browser.}',
    '  b:', '    name: B', '    description: Second system of the pair.', '    containers:',
    '      web2: {name: Web, technology: React, description: Shows pages in the browser.}',
  ];
  expectNone(lines, 'c4/duplicate-name');
});

test('c4/generic-name flags names that describe a kind of thing, not a job', () => {
  const named = (name) => systemWith([`      c:`, `        name: ${name}`, '        technology: Python', '        description: Computes schedules for students.']);
  ['Backend', 'Service A', 'DB1', 'business logic'].forEach((name) => {
    expectOne(named(name), 'c4/generic-name', { element: 'c', severity: 'info', needle: '      c:' });
  });
  ['Seat Gateway', 'Billing Service'].forEach((name) => expectNone(named(name), 'c4/generic-name'));
});

test('c4/broker-hub flags a container that looks like a message broker, unless it is a queue or topic', () => {
  const broker = (kindLine) => systemWith(['      bus:', '        name: Message Broker', ...kindLine, '        technology: RabbitMQ', '        description: Carries events between services.']);
  expectOne(broker([]), 'c4/broker-hub', { element: 'bus', severity: 'info', needle: 'bus:' });
  expectNone(broker(['        kind: queue']), 'c4/broker-hub');
});

// ---- Isolation -------------------------------------------------------------------------------

test('c4/isolated-element counts derived relationships and code links, and rates a lone code element as info', () => {
  const lines = [
    'people:', '  student:', '    name: Student', '    description: Plans one term schedule.',
    '    collaborators:', '      t: reads schedules from',
    'systems:',
    '  t:', '    name: Timetable', '    description: Publishes the schedules of each term.',
    '  s:', '    name: Planner', '    description: Plans schedules for students.', '    containers:',
    '      x:', '        name: Planner Core', '        technology: Python', '        description: Computes schedules for students.',
    '        components:',
    '          k:', '            name: Reader', '            technology: Python module', '            description: Reads published timetables.',
    '            collaborators:', '              t: reads timetables from',
    '            code:',
    '              Base: {kind: interface}',
    '              Impl: {kind: class, implements: [Base]}',
    '              Loner: {kind: class}',
    '      y:', '        name: Planner Cache', '        technology: Redis', '        description: Caches computed schedules.',
  ];
  const { text, diagnostics } = reported(lines, 'c4/isolated-element');
  assert.deepEqual(seen(text, diagnostics), [
    { element: 'Loner', severity: 'info', line: lineOf(text, 'Loner:') },
    { element: 'y', severity: 'warning', line: lineOf(text, '      y:') },
  ]);
});

// ---- Views -----------------------------------------------------------------------------------

function containersFixture(count, extraLines = []) {
  const containers = Array.from({ length: count }, (_, index) => [
    `      c${index + 1}: {name: Part ${String.fromCharCode(65 + index)}, technology: Python, description: One part of the planner.}`]).flat();
  return systemWith(containers).concat(extraLines);
}

test('c4/large-view accepts a view with 20 elements and flags one with 21', () => {
  expectNone(containersFixture(20), 'c4/large-view');
  const diagnostic = expectOne(containersFixture(21), 'c4/large-view', { element: 's', severity: 'warning', needle: '  s:' });
  assert.match(diagnostic.message, /21/);
});

test('c4/large-view honours a configured threshold', () => {
  const { diagnostics } = reported(containersFixture(6), 'c4/large-view', { thresholds: { viewElements: 5 } });
  assert.equal(diagnostics.length, 1);
});

const VIEW_FIXTURE = (viewLines) => containersFixture(1, ['views:', '  nothing:', '    view: containers of s', ...viewLines]);

test('view/empty flags a custom view that resolves to no elements', () => {
  expectOne(VIEW_FIXTURE(['    exclude: [c1]', '    description: Shows the planner parts.']), 'view/empty', { element: null, severity: 'warning', needle: 'nothing:' });
  expectNone(VIEW_FIXTURE(['    description: Shows the planner parts.']), 'view/empty');
});

test('view/no-purpose flags a custom view without a description', () => {
  expectOne(VIEW_FIXTURE([]), 'view/no-purpose', { element: null, severity: 'info', needle: 'nothing:' });
  expectNone(VIEW_FIXTURE(['    description: Shows the planner parts.']), 'view/no-purpose');
});

/**
 * A system whose API has a component and calls a neighbour system with a container, plus a system the container
 * view does not draw, with a container of its own: what a custom container view of the planner may include.
 */
const MIXED_FIXTURE = (include) => [
  'people:', '  student:', '    name: Student', '    description: Plans one term schedule.',
  '    collaborators:', '      web: plans a schedule using',
  'systems:',
  '  s:', '    name: Planner', '    description: Plans schedules for students.',
  '    containers:',
  '      web:', '        name: Planner Web App', '        technology: TypeScript, React', '        description: Shows draft schedules in the browser.',
  '        collaborators:', '          api: {description: requests schedules from, technology: JSON/HTTPS}',
  '      api:', '        name: Schedule API', '        technology: Python, FastAPI', '        description: Computes schedules without clashes.',
  '        collaborators:', '          ledger-api: {description: requests tuition charges from, technology: JSON/HTTPS}',
  '        components:',
  '          solver:', '            name: Schedule Solver', '            technology: Python', '            description: Finds a schedule without clashes.',
  '  ledger:', '    name: Tuition Ledger', '    description: Records the tuition each student owes.',
  '    containers:',
  '      ledger-api:', '        name: Ledger API', '        technology: Java', '        description: Records tuition charges.',
  '  archive:', '    name: Course Archive', '    description: Keeps past course offerings.',
  '    containers:',
  '      archive-store:', '        name: Archive Store', '        kind: database', '        technology: PostgreSQL', '        description: Stores past offerings.',
  'views:',
  '  mixed:',
  '    view: containers of s',
  '    description: Shows the planner with one part of interest.',
  `    include: [${include.join(', ')}]`,
];

test('view/mixed-abstraction flags an included element whose ancestor the view also shows', () => {
  const diagnostic = expectOne(MIXED_FIXTURE(['solver']), 'view/mixed-abstraction', { element: null, severity: 'error', needle: 'include:' });
  assert.match(diagnostic.message, /Schedule Solver, a part of Schedule API/);
  assert.match(diagnostic.hint, /components of api/);
  // The neighbour system Tuition Ledger is drawn as a box, so one of its containers would put it on two levels.
  expectOne(MIXED_FIXTURE(['ledger-api']), 'view/mixed-abstraction', { element: null, severity: 'error', needle: 'include:' });
  // An ancestor that is itself included counts as shown.
  expectOne(MIXED_FIXTURE(['archive', 'archive-store']), 'view/mixed-abstraction', { element: null, severity: 'error', needle: 'include:' });
});

test('view/mixed-abstraction allows a container of a system the view does not draw', () => {
  // Course Archive is not in the container view of the planner, so its store is drawn inside a labelled boundary of it.
  expectNone(MIXED_FIXTURE(['archive-store']), 'view/mixed-abstraction');
});

// ---- Ignores and configuration ---------------------------------------------------------------

// The student reaches the container, so the container and its system are not isolated.
const BACKEND = (checkLines = []) => [
  'people:', '  student:', '    name: Student', '    description: Plans one term schedule.',
  '    collaborators:', '      c: asks for schedules from',
  ...systemWith(['      c:', '        name: Backend', '        technology: Python', '        description: Computes schedules for students.']),
  ...checkLines,
];

function configured(lines, options = {}) {
  const { parsed, model } = load(lines);
  return checks.applyConfig(c4LayerRun(model, { parsed }), model, Object.assign({ parsed }, options));
}

function rulesOfConfigured(lines, options) {
  return configured(lines, options).map((diagnostic) => `${diagnostic.rule}${diagnostic.element ? `@${diagnostic.element}` : ''}`);
}

test('checks.ignore with a reason suppresses the rule on its element only', () => {
  const ignoring = (element) => BACKEND(['checks:', '  ignore:', '    - rule: c4/generic-name', `      element: ${element}`, '      because: the name comes from the course']);
  assert.deepEqual(rulesOfConfigured(ignoring('c')), []);
  assert.ok(rulesOfConfigured(ignoring('s')).includes('c4/generic-name@c'), 'an entry for another element does not suppress');
});

test('an ignore entry without a reason is inactive and reported as checks/unexplained-ignore', () => {
  const lines = BACKEND(['checks:', '  ignore:', '    - rule: c4/generic-name', '      element: c']);
  const result = configured(lines);
  const text = lines.join('\n');
  assert.deepEqual(result.map((diagnostic) => diagnostic.rule).sort(), ['c4/generic-name', 'checks/unexplained-ignore']);
  const unexplained = result.find((diagnostic) => diagnostic.rule === 'checks/unexplained-ignore');
  assert.equal(unexplained.severity, 'warning');
  assert.equal(unexplained.range.start.line, lineOf(text, '- rule: c4/generic-name'));
});

test('an active ignore entry that matches nothing is reported as checks/stale-ignore', () => {
  const lines = BACKEND(['checks:', '  ignore:', '    - rule: c4/broker-hub', '      because: there is no broker here']);
  const result = configured(lines);
  const stale = result.filter((diagnostic) => diagnostic.rule === 'checks/stale-ignore');
  assert.deepEqual(stale.map((diagnostic) => [diagnostic.severity, diagnostic.range.start.line]), [['info', lineOf(lines.join('\n'), '- rule: c4/broker-hub')]]);
});

test('honorFileIgnores: false keeps the suppressed diagnostics and reports no ignore problems', () => {
  const lines = BACKEND(['checks:', '  ignore:', '    - rule: c4/generic-name', '      because: the name comes from the course']);
  assert.deepEqual(rulesOfConfigured(lines, { honorFileIgnores: false }), ['c4/generic-name@c']);
});

test('disable removes a rule from the result', () => {
  assert.deepEqual(rulesOfConfigured(BACKEND(), {}), ['c4/generic-name@c']);
  assert.deepEqual(rulesOfConfigured(BACKEND(), { disable: ['c4/generic-name'] }), []);
});

test('severity re-rates a rule without changing the others', () => {
  const [diagnostic] = configured(BACKEND(), { severity: { 'c4/generic-name': 'error' } });
  assert.equal(diagnostic.severity, 'error');
  assert.equal(diagnostic.rule, 'c4/generic-name');
});

test('severity levels outside error, warning, and info are rejected', () => {
  assert.throws(() => configured(BACKEND(), { severity: { 'c4/generic-name': 'fatal' } }), /Unknown severity "fatal" for c4\/generic-name/);
});

test('applyConfig returns new diagnostics and leaves its input untouched', () => {
  const { parsed, model } = load(BACKEND());
  const raw = checks.run(model, { parsed });
  const before = JSON.stringify(raw);
  checks.applyConfig(raw, model, { severity: { 'c4/generic-name': 'error' }, hideInfo: true });
  assert.equal(JSON.stringify(raw), before);
});

test('hideInfo drops information diagnostics after re-rating', () => {
  assert.deepEqual(rulesOfConfigured(BACKEND(), { hideInfo: true }), []);
  assert.deepEqual(rulesOfConfigured(BACKEND(), { hideInfo: true, severity: { 'c4/generic-name': 'warning' } }), ['c4/generic-name@c']);
});

test('suppressIncompleteFor hides incompleteness rules on the named element only', () => {
  const lines = systemWith([
    '      web:', '        name: Backend',
    '      api:', '        name: Schedule API',
  ]);
  assert.deepEqual(rulesOfConfigured(lines).sort(), [
    'c4/generic-name@web', 'c4/no-description@api', 'c4/no-description@web', 'c4/no-technology@api', 'c4/no-technology@web',
  ].concat(rulesOfConfigured(lines).filter((id) => id.startsWith('c4/isolated-element'))).sort());
  assert.deepEqual(rulesOfConfigured(lines, { suppressIncompleteFor: ['web'] }).filter((id) => id.endsWith('@web')), ['c4/generic-name@web']);
  assert.ok(rulesOfConfigured(lines, { suppressIncompleteFor: ['web'] }).includes('c4/no-description@api'), 'other elements still report');
});
